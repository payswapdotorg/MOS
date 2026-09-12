/**
 * MKT-039 integration test — THE CREATOR OPERATIONS END-TO-END EXPERIENCE on
 * the real stack (embedded PostgreSQL 18 + real API subprocess + the
 * MKT-038 loopback sandbox creator-platform provider + the in-process
 * application wiring for the AI Router leg — the MKT-038/MKT-034
 * test-harness precedents).
 *
 * Acceptance mapping (work-item-v1.3-overrides.md MKT-039 = CREATOR-001 +
 * E2E-002, acceptance E2E-AC-02 + browser/API authorization tests;
 * requirements-v1.3.md E2E-AC-02: "a Creator Operations scenario executes
 * Goal → Workflow → AI task → Human Agent Job → provider adapter/extension
 * → Evidence/Outcome → Learning without bypassing authority boundaries —
 * end-to-end integration test"):
 *
 * THE GOLDEN PATH (E2E-AC-02) — ONE creator conversation-triage scenario,
 * every stage through the frozen public contracts, the MKT-038 provider
 * integration in the loop, the HUMAN leg driven through the GENERIC Human
 * Agent work queue (MKT-031 — no pack-specific queue anywhere), and the
 * WHOLE loop surfaced through the CLIENT DECISION ROOM (MKT-030):
 *
 *   - provider event: a signed creator-platform webhook lands in the
 *     MKT-023 append-only ledger + a derived 'source_fact' /evidence row;
 *   - Creator subjects: the pack profile/account/fan/conversation chain +
 *     the INBOUND message observation;
 *   - Goal: an ACTIVE workspace-scoped goal through /goals;
 *   - Workflow: the pack's frozen 'conversation-triage' template published
 *     through /domain-packs, installed in the loop Workspace, materialized
 *     as a REAL /workflows definition (ACTIVE) + instance (RUNNING);
 *   - AI task: an /executions runtime attempt for the template's
 *     'draft_reply' ai_task node + the pack-provisioned
 *     creator.response_drafting TaskProfile routed through the AI Router
 *     (routeTask, cascade completed, draft output validated against the
 *     profile's output schema);
 *   - Human Agent Job THROUGH THE GENERIC WORK QUEUE: the 'approve_reply'
 *     human_task node projected as a chatter-specialized Job through the
 *     GENERIC /jobs model → the chatter DISCOVERS the job through the
 *     queue discovery surface → sees the OPEN offer in MY QUEUE
 *     (descriptor view, no Client data) → ACCEPTS through the QUEUE claim
 *     surface (the same modules.jobs.acceptOffer the direct surface
 *     calls; direct-surface replay converges with replayed=true) → MY
 *     QUEUE shows the accepted job with the DERIVED outcome obligation;
 *   - APPROVED communication through the creator adapter: the pack
 *     CREATOR-AC-06 approval chain (the fail-closed unapproved-send proof
 *     FIRST, then the reviewer approval, then the gated outbound send
 *     born 'sent' carrying the allowing policy decision id) THEN the
 *     provider send through the /integrations mutation boundary
 *     (executeMutation → CreatorPlatformAdapter → REAL HTTP call to the
 *     sandbox provider, which RECORDS the approved side effect);
 *   - Evidence/Outcome: the send observation mapped into the COMMON
 *     /evidence + /metrics contracts through the pack mapping; the
 *     integration read sync delivering provider observations through the
 *     METRIC-001 emitter; the Job outcome submitted by the chatter citing
 *     the send evidence through the DIRECT /jobs outcome surface (the
 *     queue only ever DISPLAYED the obligation — UI-AC-02); the execution
 *     SUCCEEDED;
 *   - Learning: the §16 experiment declared, started, analyzed and
 *     CONCLUDED citing same-Client creator evidence (the RESULTING
 *     DECISION is the Client Decision); the Learning record appended with
 *     evidenceRefs + the CONCLUDED experimentRef; the workflow instance
 *     terminal;
 *   - THE CLIENT DECISION ROOM surfaces the WHOLE creator loop: WHAT
 *     HAPPENED (the goal + the terminal workflow instance — the shared
 *     lifecycle carrier of the AI leg, the human leg and the provider
 *     leg), WHY (the learning with applicability + refs), EVIDENCE
 *     QUALITY (the creator evidence chain: source_fact + observation
 *     postures), EXPERIMENTS (the concluded experiment with the RESULTING
 *     DECISION verbatim), RECOMMENDATIONS (the applicable learning + the
 *     experiment decision — no invented lift), APPROVALS (empty — nothing
 *     pending);
 *   - the SHARED LIFECYCLE is asserted, not narrated: the SAME
 *     workflowInstanceId rides the AI execution's taskLink, the Human
 *     Agent Job's scope and the decision room's instance recap; the SAME
 *     goalId rides the goal and the room; the learning cites the SAME
 *     evidence ids the experiment conclusion cites; the metric
 *     observation binds the send evidence; the provider saw EXACTLY ONE
 *     approved side effect.
 *
 * NEGATIVE TESTS (authority-boundary evidence at EVERY hop — the
 * established vocabulary: forged transition 409, cross-Workspace 404,
 * cross-Client 404, insufficient-role rejection, fail-closed gates):
 *   - WORKFLOW HOP: a forged instance transition (an illegal §5 edge) is
 *     the authority 409 and a CAS version race is the authority 409;
 *   - AI HOP: routing with a FOREIGN workspace's TaskProfile is the
 *     uniform NotFoundError at the composition pre-fence; a TERMINAL
 *     execution refuses further transitions (409);
 *   - QUEUE HOP: a user without a Human Agent profile has no queue
 *     surface (403); a foreign offer id is the UNIFORM 404 (no existence
 *     oracle); the losing candidate's queue claim is a clean 409 passthrough;
 *   - PROVIDER HOP: an UNAPPROVED send is denied BEFORE any row and NEVER
 *     reaches the provider (fail-closed, zero sandbox traffic); a
 *     cross-Client adapter mutation under a foreign client path is the
 *     UNIFORM 404;
 *   - EVIDENCE HOP: a material-shaped key in a pack observation payload
 *     is rejected by the frozen guards (422) with zero rows;
 *   - LEARNING HOP: an experiment conclusion from a non-analyzing state
 *     is the authority 409; a Learning citing a NON-CONCLUDED experiment
 *     is rejected (422) with zero rows;
 *   - DECISION-ROOM HOP: a foreign client's room is the UNIFORM 404;
 *   - WORKSPACE SCOPING: provisioning the pack TaskProfiles against a
 *     FOREIGN workspace is the uniform 404 (indistinguishable from
 *     unknown).
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
const CREATOR_TOKEN = 'ea-' + 'AIza' + 'fakeMkt039CreatorToken';
const CREATOR_WEBHOOK_SECRET = 'whsec_' + 'Mkt039' + 'FakeSandbox';

const PROVIDER_CONVERSATION_REF = 'conv_551';
const FAN_MESSAGE = 'Loved the new morning routine post — is the VIP bundle still available?';
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
// The fake AI provider adapter (the MKT-018/MKT-038 test precedent: the
// cascade executor takes the provider adapter as a PARAMETER; the test
// supplies a fake — no live network; the AI ROUTER itself is real).
// ---------------------------------------------------------------------------

class DraftingFakeAdapter implements ProviderAdapter {
  readonly providerLabel = 'mkt039-fake';
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
      latencyMs: 130,
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
  const owner = await makeUser(`${label}-owner@creatorexp.test`);
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

/** One Human Agent profile (the generic model — specializations are data). */
async function makeAgentProfile(principal: Principal, body: Record<string, unknown>): Promise<string> {
  const created = await apiCall(port(), '/api/field-agents', { token: principal.token, body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['agentId'] as string;
}

function chatterProfileDeclaration(): Record<string, unknown> {
  return {
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
  };
}

function provisionSecret(handle: string, material: string): void {
  fs.writeFileSync(path.join(stack!.env.secretsDir, `${handle}.secret`), material, { mode: 0o600 });
}

// The shared tenant fixtures of the golden path + the foreign negatives.
let tenant: Tenant = null as unknown as Tenant;
let bobTenant: Tenant = null as unknown as Tenant;
let chatter: Principal = null as unknown as Principal;
let chatterAgentId = '';
let connectionId = '';
let bobConnectionId = '';
let profileId = '';
let accountId = '';
let fanId = '';
let conversationId = '';
let credentialId = '';
let bobCredentialId = '';

before(async () => {
  stack = await bootStack('creatorexp');

  // The sandbox creator-platform provider (loopback; per-provider bearer
  // check; NO real network egress) — the MKT-038 integration in the loop.
  sandbox = await startSandboxProvider({ 'creator-platform': CREATOR_TOKEN });

  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-038/MKT-034 precedent):
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

  // Tenants: Alice (the creator operations experience) + Bob (the
  // cross-tenant negatives).
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

  // The CHATTER Human Agent (the generic-model worker of the review Job —
  // the queue surface serves every specialization the same way).
  chatter = await makeUser('chatter@creatorexp.test');
  chatterAgentId = await makeAgentProfile(chatter, chatterProfileDeclaration());

  // Platform policy defaults: the integration PIPE operations explicitly
  // allowed (network + secrets dimensions). Deliberately NOT '*' — the
  // creator conversation gate must stay governed by the CLIENT-scoped
  // approval-demanding policy below.
  const platformNetwork = await apiCall(port(), '/api/policies', {
    token: await adminToken(),
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['integration.connect', 'integration.read', 'integration.mutate', 'integration.webhook'],
          reason: 'MKT-039 E2E: the integration pipe operations are allowed platform-wide',
        },
      ],
      description: 'MKT-039 E2E platform network boundary (integration pipe)',
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
          reason: 'MKT-039 E2E: integration credential use and webhook verification explicitly allowed platform-wide',
        },
      ],
      description: 'MKT-039 E2E platform secrets boundary (integration credential + webhook verification)',
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
          reason: 'MKT-039 E2E: creator sends and publishes require a human approval record',
        },
      ],
      description: 'MKT-039 E2E client creator gate (approvals demanded)',
    },
  });
  assert.equal(clientGate.status, 201, JSON.stringify(clientGate.body));

  // The creator-platform credential (agency-scoped reference by logical
  // handle — never the material itself).
  provisionSecret('mkt039-creator-key', JSON.stringify({ accessToken: CREATOR_TOKEN, webhookSecret: CREATOR_WEBHOOK_SECRET }));
  provisionSecret('mkt039-bob-creator-key', JSON.stringify({ accessToken: CREATOR_TOKEN, webhookSecret: 'whsec_bob-not-used' }));
  const credential = await apiCall(port(), `/api/agencies/${tenant.agencyId}/credentials`, {
    token: tenant.owner.token,
    body: { kind: 'integration_api_key', label: 'Creator platform sandbox', secretHandle: 'mkt039-creator-key' },
  });
  assert.equal(credential.status, 201, JSON.stringify(credential.body));
  credentialId = credential.body['credentialId'] as string;
  const bobCredential = await apiCall(port(), `/api/agencies/${bobTenant.agencyId}/credentials`, {
    token: bobTenant.owner.token,
    body: { kind: 'integration_api_key', label: 'Creator platform sandbox Bob', secretHandle: 'mkt039-bob-creator-key' },
  });
  assert.equal(bobCredential.status, 201, JSON.stringify(bobCredential.body));
  bobCredentialId = bobCredential.body['credentialId'] as string;

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
  // sandbox provider over REAL HTTP.
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
      handle: 'ava-exp',
      niches: ['fitness', 'lifestyle'],
      bio: 'A fitness creator.',
      attributes: { region: 'emea' },
      idempotencyKey: 'mkt039-profile-1',
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
      idempotencyKey: 'mkt039-account-1',
    },
  });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  accountId = account.body['accountId'] as string;

  const fan = await apiCall(port(), `/api/creator-accounts/${accountId}/fans`, {
    token: tenant.owner.token,
    body: {
      fanAlias: 'top-fan-exp',
      tier: 'top_fan',
      tags: ['early-supporter'],
      attributes: {},
      idempotencyKey: 'mkt039-fan-1',
    },
  });
  assert.equal(fan.status, 201, JSON.stringify(fan.body));
  fanId = fan.body['fanId'] as string;

  const conversation = await apiCall(port(), `/api/creator-accounts/${accountId}/conversations`, {
    token: tenant.owner.token,
    body: {
      fanId,
      channel: 'dm',
      topic: 'vip-bundle-enquiry',
      attributes: {},
      idempotencyKey: 'mkt039-conversation-1',
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
// THE GOLDEN PATH — E2E-AC-02 through the generic work queue + the Client
// Decision Room (every stage through the frozen contracts)
// ---------------------------------------------------------------------------

test('E2E-AC-02 golden path: provider event → subjects → Goal → Workflow (pack template) → AI Router task → Human Agent Job THROUGH THE GENERIC WORK QUEUE → APPROVED send through the creator adapter → Evidence/Outcome → experiment (the Client Decision) → Learning → THE CLIENT DECISION ROOM', async () => {
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
  const webhookEventId = webhook.body['eventId'] as string;
  const webhookEvidenceId = webhook.body['evidenceRef'] as string;
  assert.ok(typeof webhookEvidenceId === 'string' && webhookEvidenceId.length > 0);
  const ledger = await pool().query<{ event_type: string; evidence_ref: string; adapter_key: string }>(
    'SELECT event_type, evidence_ref, adapter_key FROM integration_events WHERE event_id = $1',
    [webhookEventId],
  );
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0]!.event_type, 'creator-platform:message.created');
  assert.equal(ledger.rows[0]!.evidence_ref, webhookEvidenceId);

  // ---- the inbound message observation (the pack conversation surface) ---
  const inbound = await apiCall(port(), `/api/creator-conversations/${conversationId}/messages/inbound`, {
    token: tenant.owner.token,
    body: { body: FAN_MESSAGE, idempotencyKey: 'mkt039-inbound-1', mapToEvidence: true },
  });
  assert.equal(inbound.status, 201, JSON.stringify(inbound.body));
  assert.equal(inbound.body['direction'], 'inbound');
  assert.equal(inbound.body['status'], 'received');

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
  const goalId = goal.body['goalId'] as string;
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
    body: { idempotencyKey: 'mkt039-pack-publish-1' },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  const packId = publish.body['packId'] as string;
  assert.equal(publish.body['packKey'], 'creator-operations');

  const install = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/domain-pack-installs`, {
    token: tenant.owner.token,
    body: { packId, idempotencyKey: 'mkt039-pack-install-1' },
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
    body: { name: 'creator-triage-experience', description: 'MKT-039 E2E: the pack conversation-triage template' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body['workflowId'] as string;

  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: tenant.owner.token,
    body: content,
  });
  assert.equal(definition.status, 201, `definition creation failed: ${JSON.stringify(definition.body)}`);
  const definitionId = definition.body['workflowDefinitionId'] as string;
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

  const instance = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: tenant.owner.token,
    body: {},
  });
  assert.equal(instance.status, 201, JSON.stringify(instance.body));
  const workflowInstanceId = instance.body['workflowInstanceId'] as string;
  let instanceVersion = instance.body['version'] as number;
  for (const to of ['ready', 'running'] as const) {
    const transition = await apiCall(port(), `/api/workflows/${workflowId}/instances/${workflowInstanceId}/transitions`, {
      token: tenant.owner.token,
      body: { to, version: instanceVersion, idempotencyKey: `mkt039-instance-${to}`, reason: 'MKT-039 E2E' },
    });
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
  }

  // ---- AI task: TaskProfiles + the /executions attempt + the AI Router --
  const provisioning = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/creator-operations/task-profiles`, {
    token: tenant.owner.token,
    body: { idempotencyKey: 'mkt039-provision-1' },
  });
  assert.equal(provisioning.status, 201, JSON.stringify(provisioning.body));
  const taskProfiles = provisioning.body['taskProfiles'] as { taskClass: string; taskProfileId: string }[];
  const draftProfileId = taskProfiles.find((receipt) => receipt.taskClass === 'creator.response_drafting')!
    .taskProfileId;
  assert.ok(typeof draftProfileId === 'string' && draftProfileId.length > 0);

  // The execution: the runtime attempt of the template's draft_reply
  // ai_task node (created through the /executions authority surface) —
  // THE SHARED LIFECYCLE CARRIER of the AI leg.
  const execution = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/executions`, {
    token: tenant.owner.token,
    body: {
      workflowInstanceId,
      nodeId: 'draft_reply',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'mkt039-execution-draft-1',
    },
  });
  assert.equal(execution.status, 201, JSON.stringify(execution.body));
  const executionBody = execution.body as Record<string, unknown>;
  const executionRecord = (executionBody['execution'] ?? executionBody) as Record<string, unknown>;
  const executionId = executionRecord['executionId'] as string;
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
      providerLabel: 'mkt039-labs',
      modelKey: 'mkt039-draft-model',
      displayName: 'MKT-039 Draft Model',
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
      conversationContext: { topic: 'vip-bundle-enquiry', fanTier: 'top_fan' },
    },
    idempotencyKey: 'mkt039-route-draft-1',
    correlationId: 'mkt039-route-draft-1',
    actorId: tenant.owner.userId,
  });
  assert.equal(routing.cascadeRun.status, 'completed');
  assert.equal(routing.cascadeRun.finalModelRegistryId, modelRegistryId);
  assert.equal(routing.cascadeRun.cascadeSteps.length, 1);
  assert.equal(routing.cascadeRun.cascadeSteps[0]!.stepType, 'cheap-first');
  assert.equal(routing.cascadeRun.cascadeSteps[0]!.validatorResult, 'passed');
  assert.equal(draftingAdapter.invocations.length, 1, 'the cascade invoked the model exactly once');
  assert.equal(
    draftingAdapter.invocations[0]!.taskProfile.taskClass,
    'creator.response_drafting',
    'the routed TaskProfile is the pack-declared response-drafting class',
  );
  const draftContent = draftingAdapter.outputs[0]!;
  assert.equal(draftContent['draftReply'], DRAFT_REPLY);

  // The execution reaches its terminal state through the /executions
  // transition surface (the AI leg's runtime attempt lifecycle).
  let executionVersion = executionRecord['version'] as number;
  for (const to of ['queued', 'starting', 'running', 'succeeded'] as const) {
    const transition = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
      token: tenant.owner.token,
      body: {
        to,
        version: executionVersion,
        idempotencyKey: `mkt039-execution-${to}`,
        reason: `MKT-039 E2E: the AI draft task ${to === 'succeeded' ? 'completed with a validated draft reply' : `is ${to}`}`,
      },
    });
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    const transitionBody = (transition.body as Record<string, unknown>)['execution'] as Record<string, unknown>;
    executionVersion = transitionBody['version'] as number;
  }
  const finalExecution = await apiCall(port(), `/api/executions/${executionId}`, { token: tenant.owner.token });
  assert.equal(finalExecution.body['status'], 'succeeded');

  // ---- Human Agent Job THROUGH THE GENERIC WORK QUEUE (MKT-031) --------
  // The 'approve_reply' human_task node projects a chatter-specialized Job
  // through the GENERIC /jobs model — no pack-specific queue logic
  // anywhere: the queue serves every Human Agent specialization the same
  // way.
  const projection = await apiCall(port(), `/api/workflows/${workflowId}/instances/${workflowInstanceId}/jobs`, {
    token: tenant.owner.token,
    body: {
      nodeId: 'approve_reply',
      title: 'Approve the AI-drafted reply',
      description: 'Review the AI-drafted reply for the VIP bundle enquiry and approve the outbound send.',
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
  const jobId = job['jobId'] as string;
  assert.equal((job['eligibility'] as Record<string, unknown>)['specialization'], 'chatter');
  assert.equal(job['nodeId'], 'approve_reply');
  assert.equal(job['workflowInstanceId'], workflowInstanceId, 'the human leg rides the SAME instance as the AI leg');
  assert.equal(job['clientId'], tenant.clientId, 'the job scope is server-derived from the instance chain');

  // The commissioning offer (the §18 candidate-specific claim surface).
  const offer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenant.owner.token,
    body: { candidateAgentId: chatterAgentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  const offerId = (offer.body as Record<string, unknown>)['offerId'] as string;

  // QUEUE DISCOVERY: the chatter discovers the projected job through the
  // generic discovery surface (the eligibility-gated descriptors — the
  // queue adds no second matcher).
  const discovery = await apiCall(port(), '/api/jobs/queue/discovery', { token: chatter.token });
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
  const discoveryJobs = (discovery.body as Record<string, unknown>)['jobs'] as Record<string, unknown>[];
  const discovered = discoveryJobs.find((entry) => entry['title'] === 'Approve the AI-drafted reply');
  assert.ok(discovered !== undefined, 'the chatter discovers the projected creator job through the queue');
  const discoverySerialized = JSON.stringify(discovered);
  for (const forbiddenKey of ['clientId', 'agencyId', 'workspaceId', 'workflowInstanceId', 'nodeId']) {
    assert.ok(
      !discoverySerialized.includes(`"${forbiddenKey}"`),
      `the discovery view must not carry '${forbiddenKey}' (descriptor view only)`,
    );
  }

  // MY QUEUE: the OPEN offer in the DECISION queue (descriptor view — no
  // Client data; the chatter's own surface resolved server-side).
  const queueBefore = await apiCall(port(), '/api/jobs/queue', { token: chatter.token });
  assert.equal(queueBefore.status, 200, JSON.stringify(queueBefore.body));
  const queueBody = queueBefore.body as Record<string, unknown>;
  assert.equal((queueBody['agent'] as Record<string, unknown>)['agentId'], chatterAgentId);
  const openOffers = queueBody['offers'] as Record<string, unknown>[];
  const queueOffer = openOffers.find((entry) => entry['offerId'] === offerId);
  assert.ok(queueOffer !== undefined, 'MY QUEUE carries the open creator-job offer');
  assert.equal(queueOffer!['status'], 'open');
  const offerJobView = queueOffer!['job'] as Record<string, unknown> | null;
  if (offerJobView !== null) {
    const serialized = JSON.stringify(offerJobView);
    for (const forbiddenKey of ['clientId', 'agencyId', 'workspaceId', 'workflowInstanceId', 'nodeId']) {
      assert.ok(
        !serialized.includes(`"${forbiddenKey}"`),
        `the queue offer view must not carry '${forbiddenKey}' (descriptor view only)`,
      );
    }
  }
  assert.deepEqual(queueBody['activeJobs'], [], 'an open offer is not an execution obligation yet');

  // QUEUE ACCEPT: the concurrency-safe claim by OFFER ID ALONE — the SAME
  // modules.jobs.acceptOffer the direct surface calls (the generic queue,
  // never a second acceptance engine).
  const viaQueue = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: chatter.token,
    body: {},
  });
  assert.equal(viaQueue.status, 200, JSON.stringify(viaQueue.body));
  assert.equal(viaQueue.body['replayed'], false);
  const acceptedJob = viaQueue.body['job'] as Record<string, unknown>;
  assert.equal(acceptedJob['status'], 'accepted');
  assert.equal((acceptedJob['accepted'] as Record<string, unknown>)['agentId'], chatterAgentId);
  assert.equal(acceptedJob['clientId'], tenant.clientId, 'the full record is authorized for the winner');
  assert.equal(acceptedJob['workflowInstanceId'], workflowInstanceId, 'the accepted job still rides the SAME instance');

  // QUEUE/DIRECT CONVERGENCE: the direct MKT-026 surface replays the SAME
  // acceptance (replayed=true) with the byte-identical job/offer views.
  const viaDirect = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, {
    token: chatter.token,
    body: {},
  });
  assert.equal(viaDirect.status, 200, JSON.stringify(viaDirect.body));
  assert.equal(viaDirect.body['replayed'], true, 'the direct surface replays the queue acceptance');
  assert.deepEqual(viaDirect.body['job'], viaQueue.body['job'], 'identical job view on both surfaces');
  assert.deepEqual(viaDirect.body['offer'], viaQueue.body['offer'], 'identical offer view on both surfaces');

  // MY QUEUE now shows the ACCEPTED job with the DERIVED outcome
  // obligation (the queue DISPLAYS authoritative state; the direct
  // surfaces own the mutations — UI-AC-02).
  const queueAfter = await apiCall(port(), '/api/jobs/queue', { token: chatter.token });
  assert.equal(queueAfter.status, 200);
  const activeJobs = (queueAfter.body as Record<string, unknown>)['activeJobs'] as Record<string, unknown>[];
  const activeEntry = activeJobs.find(
    (entry) => (entry['job'] as Record<string, unknown>)['jobId'] === jobId,
  );
  assert.ok(activeEntry !== undefined, 'the accepted creator job is in MY QUEUE');
  const obligations = activeEntry!['obligations'] as Record<string, unknown>;
  assert.equal(obligations['jobOutcomeDue'], true, 'the accepted creator job owes its outcome');

  // ---- APPROVED communication through the creator adapter ---------------
  // Stage 1 — the fail-closed proof FIRST: the unapproved send is denied
  // BEFORE any row and NEVER reaches the provider.
  const sandboxRequestsBefore = sandbox!.requests('creator-platform');
  const unapproved = await apiCall(port(), `/api/creator-conversations/${conversationId}/messages/outbound`, {
    token: tenant.owner.token,
    body: { body: DRAFT_REPLY, idempotencyKey: 'mkt039-outbound-unapproved-1', approvalId: null },
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
    body: { decision: 'approved', notes: 'The AI draft is on-brand and answers the bundle question.', idempotencyKey: 'mkt039-approval-1' },
  });
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  const approvalId = approval.body['approvalId'] as string;
  assert.equal(approval.body['approverUserId'], tenant.owner.userId);
  assert.deepEqual(approval.body['approverSpecializations'], ['reviewer']);

  // Stage 3 — the pack gated send: born 'sent' carrying the ALLOWING policy
  // decision id and the satisfying approval record id.
  const sent = await apiCall(port(), `/api/creator-conversations/${conversationId}/messages/outbound`, {
    token: tenant.owner.token,
    body: { body: DRAFT_REPLY, idempotencyKey: 'mkt039-outbound-approved-1', approvalId },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body['status'], 'sent');
  assert.equal(sent.body['approvalId'], approvalId);
  const sendDecisionId = sent.body['policyDecisionId'] as string;
  assert.ok(typeof sendDecisionId === 'string' && sendDecisionId.length > 0);
  const decisionRow = await pool().query<{ outcome: string }>(
    'SELECT outcome FROM policy_decisions WHERE decision_id = $1',
    [sendDecisionId],
  );
  assert.equal(decisionRow.rows.length, 1);
  assert.equal(decisionRow.rows[0]!.outcome, 'allow');

  // Stage 4 — the PROVIDER send through the creator adapter: the
  // /integrations mutation boundary (fail-closed policy gate → in-process
  // credential resolution → the REAL adapter HTTP call to the sandbox
  // provider — the MKT-038 integration in the loop). The sandbox RECORDS
  // the provider-visible side effect.
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
      idempotencyKey: 'mkt039-observation-send-1',
    },
  });
  assert.equal(observation.status, 201, JSON.stringify(observation.body));
  const sendEvidenceId = observation.body['evidenceId'] as string;
  const sendObservationId = observation.body['observationId'] as string;
  assert.ok(typeof sendEvidenceId === 'string' && sendEvidenceId.length > 0);
  const sendMetric = await apiCall(port(), `/api/metrics/${sendObservationId}`, { token: tenant.owner.token });
  assert.equal(sendMetric.status, 200);
  assert.equal(sendMetric.body['metricName'], 'creator.conversation.event_count');
  assert.equal(sendMetric.body['evidenceRef'], sendEvidenceId);

  // The integration read sync: the adapter's account-metrics read delivered
  // through the METRIC-001 emitter into the COMMON /evidence + /metrics
  // contracts (the provider observation leg of the loop).
  const sync = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}/sync`, {
    token: tenant.owner.token,
    body: { operation: 'readAccountMetrics', parameters: {} },
  });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body['ok'], true);
  const syncReceipts = sync.body['receipts'] as Record<string, unknown>[];
  assert.equal(syncReceipts.length, 3, 'the three account-metric envelopes (fan/engagement/revenue)');
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
  assert.equal(fanCountMetric.body['evidenceRef'], fanCountReceipt['evidenceId']);

  // The Job outcome submitted by the chatter citing the send evidence
  // (through the DIRECT /jobs outcome surface — the generic queue only
  // ever DISPLAYED the obligation; the outcome is the /jobs authority's).
  const outcome = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: chatter.token,
    body: { outcome: 'succeeded', evidenceRef: sendEvidenceId },
  });
  assert.equal(outcome.status, 201, JSON.stringify(outcome.body));
  assert.equal((outcome.body['job'] as Record<string, unknown>)['status'], 'outcome_submitted');
  assert.equal((outcome.body['outcome'] as Record<string, unknown>)['evidenceRef'], sendEvidenceId);

  // MY QUEUE reflects the settled obligation (authoritative state, still
  // displayed only).
  const queueSettled = await apiCall(port(), '/api/jobs/queue', { token: chatter.token });
  assert.equal(queueSettled.status, 200);
  const settledJobs = (queueSettled.body as Record<string, unknown>)['activeJobs'] as Record<string, unknown>[];
  const settledEntry = settledJobs.find(
    (entry) => (entry['job'] as Record<string, unknown>)['jobId'] === jobId,
  );
  assert.ok(settledEntry !== undefined, 'the queue still lists the terminal job for the agent');
  assert.equal(
    (settledEntry!['obligations'] as Record<string, unknown>)['jobOutcomeDue'],
    false,
    'the submitted outcome settled the queue obligation',
  );

  // ---- the §16 experiment: the Client Decision ---------------------------
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
  const experimentId = experiment.body['experimentId'] as string;
  assert.equal(experiment.body['status'], 'draft');

  for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
    const stepped = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token: tenant.owner.token,
      body: { transition },
    });
    assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  }

  // The CONCLUSION is the Client Decision, citing the SAME same-Client
  // creator evidence the learning will cite.
  const CLIENT_DECISION =
    'Adopt: extend AI-assisted conversation triage to all top-fan enquiries — the approved reply executed through the creator-platform adapter end-to-end with a complete Goal → Workflow → AI → Human → provider → Evidence lineage.';
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
        resultingDecision: CLIENT_DECISION,
        evidenceRefs: [webhookEvidenceId, sendEvidenceId],
      },
    },
  });
  assert.equal(concluded.status, 200, JSON.stringify(concluded.body));
  assert.equal(concluded.body['status'], 'concluded');
  assert.equal(concluded.body['resultState'], 'observation');

  // ---- Learning: the durable conclusion citing the SAME evidence ---------
  const learning = await apiCall(port(), `/api/clients/${tenant.clientId}/learnings`, {
    token: tenant.owner.token,
    body: {
      statement:
        'AI-drafted, human-approved creator replies can be executed through the creator-platform adapter with a complete Goal → Workflow → AI → Human Agent work queue → provider → Evidence lineage, surfaced to the client through the Decision Room with fail-closed approval gating.',
      applicability: {
        domain: 'creator-operations',
        channel: 'dm',
        fanTier: 'top_fan',
        providerBoundary: 'integration-adapter',
        workQueue: 'generic-human-agent',
      },
      evidenceRefs: [webhookEvidenceId, sendEvidenceId],
      experimentRefs: [experimentId],
      confidence: 0.7,
    },
  });
  assert.equal(learning.status, 201, JSON.stringify(learning.body));
  const learningId = learning.body['learningId'] as string;
  const learningRead = await apiCall(port(), `/api/learnings/${learningId}`, { token: tenant.owner.token });
  assert.equal(learningRead.status, 200);
  assert.deepEqual(learningRead.body['evidenceRefs'], [webhookEvidenceId, sendEvidenceId]);
  assert.deepEqual(learningRead.body['experimentRefs'], [experimentId]);
  assert.equal(learningRead.body['status'], 'active');

  // ---- the SHARED LIFECYCLE closes: the instance terminal ----------------
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
        idempotencyKey: 'mkt039-instance-succeeded',
        reason: 'the conversation-triage instance concluded through the experiment authority',
      },
    },
  );
  assert.equal(instanceTerminal.status, 200, JSON.stringify(instanceTerminal.body));

  // ---- THE CLIENT DECISION ROOM (MKT-030) surfaces the WHOLE loop -------
  const room = await apiCall(port(), `/api/reporting/decision-room/${tenant.clientId}`, {
    token: tenant.owner.token,
  });
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const roomBody = room.body;

  assert.deepEqual(roomBody['scope'], {
    kind: 'client-decision-room',
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
  });

  // WHAT HAPPENED: the creator Goal + the creator workflow with its
  // terminal instance (the shared lifecycle carrier of the AI leg, the
  // human leg and the provider leg).
  const whatHappened = roomBody['whatHappened'] as Record<string, unknown>;
  const goals = whatHappened['goals'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(goals.length, 1);
  assert.equal(goals[0]!['goalId'], goalId);
  assert.equal(goals[0]!['status'], 'active');
  assert.equal(goals[0]!['workspaceId'], tenant.workspaceId);
  assert.equal(
    (goals[0]!['successCriteria'] as ReadonlyArray<Record<string, unknown>>)[0]!['metric'],
    'creator.conversation.event_count',
  );
  const workflows = whatHappened['workflows'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]!['workflowId'], workflowId);
  const instanceCounts = workflows[0]!['instanceCounts'] as Record<string, number>;
  assert.equal(instanceCounts['succeeded'], 1);
  const roomInstances = workflows[0]!['instances'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(roomInstances.length, 1);
  assert.equal(roomInstances[0]!['workflowInstanceId'], workflowInstanceId, 'the room recaps the SAME shared instance');
  assert.equal(roomInstances[0]!['status'], 'succeeded');

  // WHY: the creator Learning (the §17 hop) with its applicability + refs.
  const why = (roomBody['why'] as Record<string, unknown>)['learnings'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(why.length, 1);
  assert.equal(why[0]!['learningId'], learningId);
  assert.equal(why[0]!['status'], 'active');
  assert.deepEqual(why[0]!['evidenceRefs'], [webhookEvidenceId, sendEvidenceId]);
  assert.deepEqual(why[0]!['experimentRefs'], [experimentId]);
  assert.deepEqual((roomBody['why'] as Record<string, unknown>)['learningStatusCounts'], {
    active: 1,
    superseded: 0,
    contradicted: 0,
    retired: 0,
  });

  // EVIDENCE QUALITY: the creator evidence chain — the provider webhook
  // source_fact + the three integration read-sync source facts (grade C)
  // and the pack-mapped observation rows (inbound + send, grade C).
  const quality = roomBody['evidenceQuality'] as Record<string, unknown>;
  assert.equal(quality['totalRecords'], 6, 'webhook + 3 sync reads + inbound + send observations');
  const byClass = quality['byClass'] as ReadonlyArray<Record<string, unknown>>;
  const sourceFactPosture = byClass.find((entry) => entry['class'] === 'source_fact')!;
  assert.deepEqual(sourceFactPosture['gradeCounts'], { A: 0, B: 0, C: 4, D: 0, E: 0, F: 0 });
  const observationPosture = byClass.find((entry) => entry['class'] === 'observation')!;
  assert.deepEqual(observationPosture['gradeCounts'], { A: 0, B: 0, C: 2, D: 0, E: 0, F: 0 });

  // EXPERIMENTS: the creator experiment with the RESULTING DECISION (the
  // Client Decision) surfaced verbatim — never re-derived.
  const experimentsView = roomBody['experiments'] as Record<string, unknown>;
  const experiments = experimentsView['experiments'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(experiments.length, 1);
  const concludedView = experiments.find((entry) => entry['experimentId'] === experimentId)!;
  assert.equal(concludedView['status'], 'concluded');
  assert.equal(concludedView['designType'], 'observational');
  assert.equal(concludedView['primaryMetricName'], 'creator.conversation.event_count');
  assert.equal(concludedView['resultState'], 'observation');
  assert.equal(concludedView['resultingDecision'], CLIENT_DECISION, 'the Client Decision is surfaced verbatim');

  // RECOMMENDATIONS: exactly the applicable learning + the declared
  // experiment decision — no invented lift.
  const recommendations = roomBody['recommendations'] as Record<string, unknown>;
  assert.equal(recommendations['basis'], 'applicable_learnings_and_declared_experiment_decisions');
  const items = recommendations['items'] as ReadonlyArray<Record<string, unknown>>;
  const learningItems = items.filter((item) => item['kind'] === 'applicable_learning');
  const decisionItems = items.filter((item) => item['kind'] === 'experiment_decision');
  assert.equal(learningItems.length, 1);
  assert.equal(learningItems[0]!['learningId'], learningId);
  assert.equal(decisionItems.length, 1);
  assert.equal(decisionItems[0]!['experimentId'], experimentId);
  assert.equal(decisionItems[0]!['resultingDecision'], CLIENT_DECISION);
  for (const forbidden of ['lift', 'causalLift', 'incrementalEffect', 'uplift']) {
    assert.ok(!(forbidden in decisionItems[0]!), `the recommendation vocabulary has no '${forbidden}' field`);
  }

  // APPROVALS: nothing pending — the experiment concluded and the shared
  // instance reached its terminal state.
  const approvals = (roomBody['approvals'] as Record<string, unknown>)['items'] as readonly unknown[];
  assert.equal(approvals.length, 0);

  // ---- THE SHARED LIFECYCLE re-read (asserted, not narrated) ------------
  // The SAME workflowInstanceId rode the AI execution's taskLink, the
  // Human Agent Job's scope, and the room's recap; the SAME goalId rode
  // the goal and the room; the learning cites the SAME evidence ids the
  // conclusion cites; the provider saw EXACTLY one approved side effect.
  const goalFinal = await apiCall(port(), `/api/goals/${goalId}`, { token: tenant.owner.token });
  assert.equal(goalFinal.body['status'], 'active');
  const executionFinal = await apiCall(port(), `/api/executions/${executionId}`, { token: tenant.owner.token });
  assert.equal(executionFinal.body['status'], 'succeeded');
  assert.deepEqual((executionFinal.body as Record<string, unknown>)['taskLink'], {
    kind: 'workflow-node',
    workflowInstanceId,
    nodeId: 'draft_reply',
  });
  const jobFinal = await apiCall(port(), `/api/jobs/${jobId}`, { token: tenant.owner.token });
  assert.equal(jobFinal.status, 200);
  assert.equal((jobFinal.body as Record<string, unknown>)['workflowInstanceId'], workflowInstanceId);
  assert.equal((jobFinal.body as Record<string, unknown>)['nodeId'], 'approve_reply');
  assert.equal((jobFinal.body as Record<string, unknown>)['status'], 'outcome_submitted');
  const outboundFinal = await pool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM creator_conversation_messages WHERE direction = 'outbound' AND conversation_id = $1",
    [conversationId],
  );
  assert.equal(Number(outboundFinal.rows[0]!.count), 1);
  assert.equal(sandbox!.creatorSends().length, 1, 'only the single APPROVED golden-path send ever reached the provider');
});

// ---------------------------------------------------------------------------
// NEGATIVE — WORKFLOW HOP: forged instance transitions are the authority 409
// ---------------------------------------------------------------------------

test('workflow authority: a forged instance transition (illegal §5 edge) and a CAS version race are both authority 409s', async () => {
  // A fresh RUNNING instance of the pack template under Alice's tenant.
  const workflow = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/workflows`, {
    token: tenant.owner.token,
    body: { name: 'creator-triage-forged', description: 'MKT-039 negative: forged instance transitions' },
  });
  assert.equal(workflow.status, 201);
  const workflowId = workflow.body['workflowId'] as string;

  const artifacts = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/domain-pack-artifacts`, {
    token: tenant.owner.token,
  });
  const template = (artifacts.body as { artifacts: { artifactName: string; payload: Record<string, unknown> }[] })
    .artifacts.find((artifact) => artifact.artifactName === 'conversation-triage')!;
  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: tenant.owner.token,
    body: template.payload,
  });
  assert.equal(definition.status, 201, JSON.stringify(definition.body));
  const definitionId = definition.body['workflowDefinitionId'] as string;
  let definitionVersion = definition.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
      token: tenant.owner.token,
      method: 'PATCH',
      body: { status, version: definitionVersion },
    });
    assert.equal(next.status, 200);
    definitionVersion = next.body['version'] as number;
  }
  const instance = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: tenant.owner.token,
    body: {},
  });
  const instanceId = instance.body['workflowInstanceId'] as string;
  let instanceVersion = instance.body['version'] as number;
  for (const to of ['ready', 'running'] as const) {
    const transition = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
      token: tenant.owner.token,
      body: { to, version: instanceVersion, idempotencyKey: `mkt039-forged-${to}`, reason: 'MKT-039 negative setup' },
    });
    assert.equal(transition.status, 200);
    instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
  }

  // FORGED EDGE: running → ready is not a frozen §5 edge — the authority 409.
  const forgedEdge = await apiCall(
    port(),
    `/api/workflows/${workflowId}/instances/${instanceId}/transitions`,
    {
      token: tenant.owner.token,
      body: { to: 'ready', version: instanceVersion, idempotencyKey: 'mkt039-forged-edge-1', reason: 'forged edge' },
    },
  );
  assert.equal(forgedEdge.status, 409, `the forged transition must 409: ${JSON.stringify(forgedEdge.body)}`);

  // CAS RACE: a stale version token loses the race — the authority 409.
  const stale = await apiCall(
    port(),
    `/api/workflows/${workflowId}/instances/${instanceId}/transitions`,
    {
      token: tenant.owner.token,
      body: { to: 'paused', version: 1, idempotencyKey: 'mkt039-forged-cas-1', reason: 'stale token' },
    },
  );
  assert.equal(stale.status, 409, `the stale CAS token must 409: ${JSON.stringify(stale.body)}`);

  // The instance state is reconcilable (still running, transition history intact).
  const after = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: tenant.owner.token,
  });
  assert.equal(after.body['status'], 'running');
});

// ---------------------------------------------------------------------------
// NEGATIVE — AI HOP: the foreign TaskProfile fence + terminal execution
// refusal
// ---------------------------------------------------------------------------

test('AI runtime authority: routing with a FOREIGN workspace TaskProfile is the uniform NotFoundError; a TERMINAL execution refuses transitions (409)', async () => {
  // A TaskProfile in a FOREIGN workspace (created through the real
  // /ai-runtime HTTP surface of the foreign tenant).
  const foreignProfile = await apiCall(port(), `/api/workspaces/${bobTenant.workspaceId}/ai/task-profiles`, {
    token: bobTenant.owner.token,
    body: {
      taskClass: 'creator.response_drafting',
      qualityTarget: 'outreach-ready',
      riskClass: 'medium',
      contextRequirements: { minInputTokens: 100, maxInputTokens: 4000 },
      latencyTargetMs: 30_000,
      maxCostPerInvocation: 0.25,
      privacyClass: 'internal',
      toolRequirements: [],
      outputSchema: {
        type: 'object',
        properties: { draftReply: { type: 'string', description: 'the drafted reply' } },
        required: ['draftReply'],
      },
      evaluatorIds: [],
      escalationPolicy: { maxEscalations: 1, fallback: 'human-review' },
      idempotencyKey: 'mkt039-foreign-profile-1',
    },
  });
  assert.equal(foreignProfile.status, 201, JSON.stringify(foreignProfile.body));
  const foreignProfileId = ((foreignProfile.body as Record<string, unknown>)['taskProfile'] as Record<string, unknown>)['taskProfileId'] as string;

  // The pack-provisioned profile of Alice's workspace.
  const provisioning = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/creator-operations/task-profiles`, {
    token: tenant.owner.token,
    body: { idempotencyKey: 'mkt039-ai-fence-provision-1' },
  });
  assert.equal(provisioning.status, 201);
  const ownProfileId = (provisioning.body['taskProfiles'] as { taskClass: string; taskProfileId: string }[])
    .find((receipt) => receipt.taskClass === 'creator.response_drafting')!.taskProfileId;

  // Routing Alice's scenario against the FOREIGN profile: uniform 404 at
  // the composition pre-fence (a foreign profile id is not a traversal
  // oracle).
  await assert.rejects(
    aiRuntime!.routeTask({
      workspaceId: tenant.workspaceId,
      clientId: tenant.clientId,
      agencyId: tenant.agencyId,
      taskProfileId: foreignProfileId,
      routingPolicyId: null,
      adapter: new DraftingFakeAdapter({ draftReply: 'never' }),
      validator: defaultValidator,
      invocationInput: { messageHistory: [{ direction: 'inbound', body: 'probe' }] },
      idempotencyKey: 'mkt039-route-foreign-1',
      correlationId: 'mkt039-route-foreign-1',
      actorId: tenant.owner.userId,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error, `expected an error, got ${String(error)}`);
      assert.match(error.message, /task-profile/i);
      return true;
    },
  );

  // And an UNKNOWN profile id is the same uniform rejection.
  await assert.rejects(
    aiRuntime!.routeTask({
      workspaceId: tenant.workspaceId,
      clientId: tenant.clientId,
      agencyId: tenant.agencyId,
      taskProfileId: '00000000-0000-0000-0000-000000000000',
      routingPolicyId: null,
      adapter: new DraftingFakeAdapter({ draftReply: 'never' }),
      validator: defaultValidator,
      invocationInput: { messageHistory: [{ direction: 'inbound', body: 'probe' }] },
      idempotencyKey: 'mkt039-route-unknown-1',
      correlationId: 'mkt039-route-unknown-1',
      actorId: tenant.owner.userId,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );

  // The OWN profile still routes fine after the fence probes (the
  // authority state is untouched — no partial writes).
  const routing = await aiRuntime!.routeTask({
    workspaceId: tenant.workspaceId,
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
    taskProfileId: ownProfileId,
    routingPolicyId: null,
    adapter: new DraftingFakeAdapter({ draftReply: 'probe-ok' }),
    validator: defaultValidator,
    invocationInput: { messageHistory: [{ direction: 'inbound', body: 'probe' }] },
    idempotencyKey: 'mkt039-route-own-1',
    correlationId: 'mkt039-route-own-1',
    actorId: tenant.owner.userId,
  });
  assert.equal(routing.cascadeRun.status, 'completed');

  // A TERMINAL execution refuses further transitions (409 — a dead
  // execution cannot mint lifecycle): a fresh execution is driven to
  // succeeded, then a further transition attempt is the authority 409.
  const execution = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/executions`, {
    token: tenant.owner.token,
    body: {
      externalRequestRef: 'mkt039-terminal-exec-probe',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'mkt039-terminal-exec-1',
    },
  });
  assert.equal(execution.status, 201, JSON.stringify(execution.body));
  const executionRecord = (execution.body['execution'] ?? execution.body) as Record<string, unknown>;
  const executionId = executionRecord['executionId'] as string;
  let version = executionRecord['version'] as number;
  for (const to of ['queued', 'starting', 'running', 'succeeded'] as const) {
    const transition = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
      token: tenant.owner.token,
      body: { to, version, idempotencyKey: `mkt039-terminal-exec-${to}`, reason: 'MKT-039 negative setup' },
    });
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    version = ((transition.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['version'] as number;
  }
  const resurrect = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
    token: tenant.owner.token,
    body: { to: 'running', version, idempotencyKey: 'mkt039-terminal-exec-resurrect', reason: 'forged resurrection' },
  });
  assert.equal(resurrect.status, 409, `a terminal execution refuses transitions: ${JSON.stringify(resurrect.body)}`);
});

// ---------------------------------------------------------------------------
// NEGATIVE — QUEUE HOP: the generic queue's own authority fences
// ---------------------------------------------------------------------------

test('work queue authority: no profile → 403; a foreign offer id → uniform 404; the losing candidate claim → clean 409', async () => {
  // A user WITHOUT a Human Agent profile has no queue surface at all.
  const plain = await makeUser('plain-queue@creatorexp.test');
  const forbidden = await apiCall(port(), '/api/jobs/queue', { token: plain.token });
  assert.equal(forbidden.status, 403);

  // A fresh creator job + offer under Alice's tenant (the generic model).
  const workflow = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/workflows`, {
    token: tenant.owner.token,
    body: { name: 'creator-triage-queuefence', description: 'MKT-039 negative: queue fences' },
  });
  const workflowId = workflow.body['workflowId'] as string;
  const artifacts = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/domain-pack-artifacts`, {
    token: tenant.owner.token,
  });
  const template = (artifacts.body as { artifacts: { artifactName: string; payload: Record<string, unknown> }[] })
    .artifacts.find((artifact) => artifact.artifactName === 'conversation-triage')!;
  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: tenant.owner.token,
    body: template.payload,
  });
  const definitionId = definition.body['workflowDefinitionId'] as string;
  let definitionVersion = definition.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
      token: tenant.owner.token,
      method: 'PATCH',
      body: { status, version: definitionVersion },
    });
    assert.equal(next.status, 200);
    definitionVersion = next.body['version'] as number;
  }
  const instance = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: tenant.owner.token,
    body: {},
  });
  const instanceId = instance.body['workflowInstanceId'] as string;
  let instanceVersion = instance.body['version'] as number;
  for (const to of ['ready', 'running'] as const) {
    const transition = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
      token: tenant.owner.token,
      body: { to, version: instanceVersion, idempotencyKey: `mkt039-queuefence-${to}`, reason: 'setup' },
    });
    assert.equal(transition.status, 200);
    instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
  }
  const projection = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/jobs`, {
    token: tenant.owner.token,
    body: {
      nodeId: 'approve_reply',
      title: 'Queue fence probe',
      description: 'MKT-039 negative: queue authority fences',
      specialization: 'chatter',
      requiredCapabilities: ['community_reply'],
      territory: { kind: 'city', value: 'accra' },
      dayOfWeek: 2,
      startMinute: 540,
      endMinute: 1020,
    },
  });
  assert.equal(projection.status, 201, JSON.stringify(projection.body));
  const jobId = (projection.body as Record<string, unknown>)['jobId'] as string;

  // The winner (the golden chatter) + the loser (a second chatter profile).
  const loser = await makeUser('loser-chatter@creatorexp.test');
  const loserAgentId = await makeAgentProfile(loser, chatterProfileDeclaration());
  const winnerOffer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenant.owner.token,
    body: { candidateAgentId: chatterAgentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(winnerOffer.status, 201);
  const winnerOfferId = (winnerOffer.body as Record<string, unknown>)['offerId'] as string;
  const loserOffer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenant.owner.token,
    body: { candidateAgentId: loserAgentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(loserOffer.status, 201);
  const loserOfferId = (loserOffer.body as Record<string, unknown>)['offerId'] as string;

  // A FOREIGN offer id: the plain user (and the foreign tenant's owner)
  // probing an offer addressed to someone else is the UNIFORM 404 —
  // indistinguishable from an unknown identifier (no existence oracle).
  const foreignClaim = await apiCall(port(), `/api/jobs/queue/offers/${winnerOfferId}/accept`, {
    token: plain.token,
    body: {},
  });
  const unknownClaim = await apiCall(port(), '/api/jobs/queue/offers/00000000-0000-4000-8000-000000000000/accept', {
    token: plain.token,
    body: {},
  });
  assert.equal(foreignClaim.status, 404);
  assert.equal(unknownClaim.status, 404, 'a foreign offer is indistinguishable from an unknown one');
  const foreignOwner = await apiCall(port(), `/api/jobs/queue/offers/${winnerOfferId}/accept`, {
    token: bobTenant.owner.token,
    body: {},
  });
  assert.equal(foreignOwner.status, 404);

  // The winner claims through the queue; the LOSER's claim conflicts (the
  // SAME module decision — clean 409, never a partial state).
  const won = await apiCall(port(), `/api/jobs/queue/offers/${winnerOfferId}/accept`, {
    token: chatter.token,
    body: {},
  });
  assert.equal(won.status, 200, JSON.stringify(won.body));
  const lost = await apiCall(port(), `/api/jobs/queue/offers/${loserOfferId}/accept`, {
    token: loser.token,
    body: {},
  });
  assert.equal(lost.status, 409, `the losing claim must conflict: ${JSON.stringify(lost.body)}`);
  const row = await pool().query<{ status: string; accepted_user_id: string }>(
    'SELECT status, accepted_user_id FROM jobs WHERE job_id = $1',
    [jobId],
  );
  assert.equal(row.rows[0]!['status'], 'accepted');
  assert.equal(row.rows[0]!['accepted_user_id'], chatter.userId, 'exactly one winner — no partial state');
});

// ---------------------------------------------------------------------------
// NEGATIVE — PROVIDER HOP: cross-client adapter operations are uniform 404s
// ---------------------------------------------------------------------------

test('provider hop fence: cross-client adapter operations under a foreign client path are UNIFORM 404s (no provider-visible side effect)', async () => {
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

  // Zero provider-visible side effects from the probes.
  assert.equal(sandbox!.creatorSends().length, 1, 'only the single APPROVED golden-path send ever reached the provider');
});

// ---------------------------------------------------------------------------
// NEGATIVE — EVIDENCE HOP: the frozen pack guards reject material-shaped
// payload keys BEFORE any row (§21/CRED-001)
// ---------------------------------------------------------------------------

test('evidence hop guard: a material-shaped key in a pack observation payload is rejected (422) with ZERO rows', async () => {
  const before = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM evidence WHERE client_id = $1',
    [tenant.clientId],
  );
  const rejected = await apiCall(port(), `/api/clients/${tenant.clientId}/creator-observations`, {
    token: tenant.owner.token,
    body: {
      subjectKind: 'conversation',
      subjectRef: conversationId,
      eventKind: 'message_sent',
      content: { direction: 'outbound', secret: 'leak-attempt' },
      observedAt: new Date().toISOString(),
      quality: 'C',
      metric: {
        name: 'creator.conversation.event_count',
        value: 1,
        unit: 'events',
        dimensions: { conversationId },
        aggregationMethod: null,
      },
      idempotencyKey: 'mkt039-guard-material-1',
    },
  });
  assert.equal(rejected.status, 422, `the §21 guard must reject material keys: ${JSON.stringify(rejected.body)}`);
  const after = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM evidence WHERE client_id = $1',
    [tenant.clientId],
  );
  assert.equal(after.rows[0]!.count, before.rows[0]!.count, 'nothing was written by the rejected observation');
});

// ---------------------------------------------------------------------------
// NEGATIVE — LEARNING HOP: forged experiment lifecycle + non-concluded
// experiment references
// ---------------------------------------------------------------------------

test('learning hop fences: a conclusion from a non-analyzing experiment is the authority 409; a Learning citing a NON-CONCLUDED experiment is rejected (422) with zero rows', async () => {
  // A fresh DRAFT experiment for Alice.
  const experiment = await apiCall(port(), `/api/clients/${tenant.clientId}/experiments`, {
    token: tenant.owner.token,
    body: {
      hypothesis: 'MKT-039 fence: a forged conclusion must never land',
      decisionTarget: 'whether the forged conclusion is rejected',
      populationUnit: 'creator-conversation',
      treatment: 'none',
      comparison: 'none',
      assignmentMethod: 'single-arm observational cohort',
      designType: 'observational',
      primaryMetric: { name: 'creator.conversation.event_count', dimensions: { scenario: 'fence' } },
      guardrails: [],
      analysisMethod: 'descriptive',
      stopCriteria: 'never',
      minimumEvidenceRequirement: 'none',
      uncertaintyRepresentation: 'interval',
      workspaceId: tenant.workspaceId,
    },
  });
  assert.equal(experiment.status, 201, JSON.stringify(experiment.body));
  const experimentId = experiment.body['experimentId'] as string;

  // FORGED LIFECYCLE: conclude from DRAFT (skipping mark_ready/start/
  // begin_analysis) is the authority 409 (the frozen state machine).
  const forged = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: tenant.owner.token,
    body: {
      transition: 'conclude',
      conclusion: {
        resultState: 'observation',
        uncertainty: { kind: 'interval', lower: 0, upper: 1, level: 0.9 },
        assumptions: [],
        sampleLimitations: [],
        confounders: [],
        resultingDecision: 'must never land',
        evidenceRefs: [],
      },
    },
  });
  assert.equal(forged.status, 409, `the forged conclusion must 409: ${JSON.stringify(forged.body)}`);
  const stillDraft = await apiCall(port(), `/api/experiments/${experimentId}`, { token: tenant.owner.token });
  assert.equal(stillDraft.body['status'], 'draft', 'the experiment stays draft (reconcilable, no partial write)');

  // A Learning citing the NON-CONCLUDED experiment is rejected (422-class)
  // with ZERO learning rows.
  const learningsBefore = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM learnings WHERE client_id = $1',
    [tenant.clientId],
  );
  const rejected = await apiCall(port(), `/api/clients/${tenant.clientId}/learnings`, {
    token: tenant.owner.token,
    body: {
      statement: 'A learning citing a non-concluded experiment must never land.',
      applicability: { domain: 'creator-operations' },
      evidenceRefs: [],
      experimentRefs: [experimentId],
      confidence: 0.5,
    },
  });
  assert.equal(rejected.status, 422, `the non-concluded reference must be rejected: ${JSON.stringify(rejected.body)}`);
  const learningsAfter = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM learnings WHERE client_id = $1',
    [tenant.clientId],
  );
  assert.equal(learningsAfter.rows[0]!.count, learningsBefore.rows[0]!.count, 'zero learning rows were written');
});

// ---------------------------------------------------------------------------
// NEGATIVE — DECISION-ROOM HOP + WORKSPACE SCOPING: uniform 404s
// ---------------------------------------------------------------------------

test('decision-room hop fence: a foreign client room is the UNIFORM 404; the pack TaskProfiles cannot be provisioned into a FOREIGN workspace', async () => {
  // A foreign client's room is indistinguishable from an unknown one.
  const foreignRoom = await apiCall(port(), `/api/reporting/decision-room/${bobTenant.clientId}`, {
    token: tenant.owner.token,
  });
  const unknownRoom = await apiCall(port(), '/api/reporting/decision-room/00000000-0000-4000-8000-000000000000', {
    token: tenant.owner.token,
  });
  assert.equal(foreignRoom.status, 404);
  assert.equal(unknownRoom.status, 404);
  assert.equal(foreignRoom.status, unknownRoom.status, 'no cross-client oracle on the decision-room surface');

  // The pack's workspace-scoped TaskProfile provisioning cannot be driven
  // against a FOREIGN workspace (Bob's): uniform 404, indistinguishable
  // from an unknown workspace id.
  const foreignWorkspace = await apiCall(
    port(),
    `/api/workspaces/${bobTenant.workspaceId}/creator-operations/task-profiles`,
    {
      token: tenant.owner.token,
      body: { idempotencyKey: 'mkt039-foreign-workspace-provision-1' },
    },
  );
  const unknownWorkspace = await apiCall(
    port(),
    '/api/workspaces/00000000-0000-4000-8000-000000000000/creator-operations/task-profiles',
    {
      token: tenant.owner.token,
      body: { idempotencyKey: 'mkt039-unknown-workspace-provision-1' },
    },
  );
  assert.equal(foreignWorkspace.status, 404);
  assert.equal(unknownWorkspace.status, 404);
  assert.equal(
    foreignWorkspace.status,
    unknownWorkspace.status,
    'a foreign workspace id is indistinguishable from an unknown one on the pack surface',
  );
});

// ---------------------------------------------------------------------------
// NEGATIVE — INSUFFICIENT ROLE: the pack guards demand owner|admin on pack
// mutations (a member with a lower role is 403)
// ---------------------------------------------------------------------------

test('pack role enforcement: a client_collaborator cannot mutate pack subjects or provision TaskProfiles (403), but reads stay allowed', async () => {
  // A collaborator member of Alice's agency.
  const collaborator = await makeUser('collaborator@creatorexp.test');
  const admin = await adminToken();
  const membership = await apiCall(port(), `/api/agencies/${tenant.agencyId}/memberships`, {
    token: admin,
    body: { userId: collaborator.userId, role: 'client_collaborator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));

  // INSUFFICIENT ROLE on the pack subject mutation: 403.
  const rejectedProfile = await apiCall(port(), `/api/clients/${tenant.clientId}/creator-profiles`, {
    token: collaborator.token,
    body: {
      displayName: 'Never Lands',
      handle: 'never-lands',
      niches: ['fitness'],
      bio: 'must never land',
      attributes: {},
      idempotencyKey: 'mkt039-collab-profile-1',
    },
  });
  assert.equal(rejectedProfile.status, 403, `the collaborator must not mutate pack subjects: ${JSON.stringify(rejectedProfile.body)}`);

  // INSUFFICIENT ROLE on the pack outbound send: 403.
  const rejectedSend = await apiCall(port(), `/api/creator-conversations/${conversationId}/messages/outbound`, {
    token: collaborator.token,
    body: { body: 'never', idempotencyKey: 'mkt039-collab-send-1', approvalId: null },
  });
  assert.equal(rejectedSend.status, 403);

  // INSUFFICIENT ROLE on the workspace-scoped TaskProfile provisioning: 403.
  const rejectedProvision = await apiCall(
    port(),
    `/api/workspaces/${tenant.workspaceId}/creator-operations/task-profiles`,
    {
      token: collaborator.token,
      body: { idempotencyKey: 'mkt039-collab-provision-1' },
    },
  );
  assert.equal(rejectedProvision.status, 403, `the collaborator must not provision pack TaskProfiles: ${JSON.stringify(rejectedProvision.body)}`);

  // READS stay allowed for any ACTIVE member of the owning agency (the
  // pack read posture — the same membership authority, no second engine).
  const readProfiles = await apiCall(port(), `/api/clients/${tenant.clientId}/creator-profiles`, {
    token: collaborator.token,
  });
  assert.equal(readProfiles.status, 200);
  const readConversation = await apiCall(port(), `/api/creator-conversations/${conversationId}`, {
    token: collaborator.token,
  });
  assert.equal(readConversation.status, 200);

  // The pack rows were never written by the rejected mutations.
  const profileCount = await pool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM creator_profiles WHERE handle = 'never-lands'",
  );
  assert.equal(Number(profileCount.rows[0]!.count), 0);
});
