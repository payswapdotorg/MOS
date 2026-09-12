/**
 * MKT-039 integration test — the CREATOR OPERATIONS API AUTHORIZATION MODEL
 * on the pack's routes (work-item-v1.3-overrides.md MKT-039 acceptance:
 * "E2E-AC-02 plus browser/API authorization tests" — this is the API
 * authorization half; the browser half lives in
 * creator-operations-decision-room-browser.test.ts and the end-to-end
 * experience in creator-operations-experience-e2e.test.ts).
 *
 * Proves the pack's frozen authorization model (spec/
 * creator-operations-v1.3.md §8 privacy boundary + the MKT-037 pack route
 * contract — "every pack-owned record carries the EXISTING agency/client
 * scope chain" and "tenant/client authorization stays the /clients +
 * /agencies authorities"):
 *
 *   - WORKSPACE SCOPING: the pack's Workspace-scoped surfaces (the
 *     TaskProfile provisioning route and the /domain-packs install route)
 *     resolve the canonical workspace ownership from durable state and
 *     authorize against the agency that OWNS the workspace's Client. A
 *     workspace of a Client of ANOTHER agency is the UNIFORM 404 —
 *     indistinguishable from an unknown or malformed identifier (no
 *     cross-tenant oracle, TENANT-AC-05 posture one level deeper); a
 *     SECOND workspace of the SAME client is reachable by the owning
 *     agency's owner (a Workspace is an organizational boundary INSIDE one
 *     Client, never a membership boundary);
 *
 *   - ROLE/AUTHORITY ENFORCEMENT per the pack guards: the pack's MUTATION
 *     surfaces demand agency_owner|agency_admin (subject recording, the
 *     gated outbound send, the publish-approval records, the observation
 *     mapping, the TaskProfile provisioning) — an agency_operator and a
 *     client_collaborator are 403 (insufficient role; the same
 *     /agencies membership authority as every other scoped check — no
 *     second permission engine); the pack's READ surfaces serve ANY
 *     active member of the owning agency (client_collaborator included);
 *     a foreign agency's member is the UNIFORM 404 on reads (the hard
 *     tenant boundary);
 *
 *   - CROSS-CLIENT 404: a pack subject of a foreign client is
 *     indistinguishable from an unknown one on EVERY subject surface
 *     (read + the gated send + the approval history);
 *
 *   - the pack's frozen input guards: a material-shaped key (§21/CRED-001)
 *     and an authority-shaped DTO key (identity/scope/lifecycle/gate
 *     provenance are server-derived) are each rejected 422 BEFORE any
 *     module work with ZERO rows written.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PASSWORD = 'a-very-long-password-123';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

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
  const owner = await makeUser(`${label}-owner@creatorauthz.test`);
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

// ---------------------------------------------------------------------------
// Shared topology: agency A (owner, operator, collaborator; client A with
// TWO workspaces) and agency B (owner; one client + workspace) — the
// cross-tenant side of the fence matrix.
// ---------------------------------------------------------------------------

let tenantA: Tenant = null as unknown as Tenant;
let tenantB: Tenant = null as unknown as Tenant;
let collaboratorA: Principal = null as unknown as Principal;
let operatorA: Principal = null as unknown as Principal;
let workspaceA2 = '';
let profileA = '';
let conversationA = '';
let packId = '';

before(async () => {
  stack = await bootStack('creatorauthz');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);

  tenantA = await makeTenant('alpha');
  tenantB = await makeTenant('bravo');
  collaboratorA = await makeUser('collab@creatorauthz.test');
  operatorA = await makeUser('operator@creatorauthz.test');
  const admin = await adminToken();
  for (const [user, role] of [
    [collaboratorA, 'client_collaborator'],
    [operatorA, 'agency_operator'],
  ] as const) {
    const membership = await apiCall(port(), `/api/agencies/${tenantA.agencyId}/memberships`, {
      token: admin,
      body: { userId: user.userId, role },
    });
    assert.equal(membership.status, 201, JSON.stringify(membership.body));
  }

  // A SECOND workspace of the SAME client (the intra-client boundary
  // probe — organizational, never a membership boundary).
  const secondWorkspace = await apiCall(port(), `/api/clients/${tenantA.clientId}/workspaces`, {
    token: admin,
    body: { name: 'Workspace alpha two' },
  });
  assert.equal(secondWorkspace.status, 201);
  workspaceA2 = secondWorkspace.body['workspaceId'] as string;

  // The pack subject chain of client A (created by the owner).
  const profile = await apiCall(port(), `/api/clients/${tenantA.clientId}/creator-profiles`, {
    token: tenantA.owner.token,
    body: {
      displayName: 'Ava Creator',
      handle: 'ava-authz',
      niches: ['fitness'],
      bio: 'A fitness creator.',
      attributes: {},
      idempotencyKey: 'authz-profile-1',
    },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  profileA = profile.body['profileId'] as string;

  const account = await apiCall(port(), `/api/creator-profiles/${profileA}/accounts`, {
    token: tenantA.owner.token,
    body: {
      platformLabel: 'creator-platform-1',
      accountHandle: 'ava_authz',
      metadata: {},
      idempotencyKey: 'authz-account-1',
    },
  });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  const accountId = account.body['accountId'] as string;

  const fan = await apiCall(port(), `/api/creator-accounts/${accountId}/fans`, {
    token: tenantA.owner.token,
    body: {
      fanAlias: 'authz-fan',
      tier: 'top_fan',
      tags: [],
      attributes: {},
      idempotencyKey: 'authz-fan-1',
    },
  });
  assert.equal(fan.status, 201, JSON.stringify(fan.body));

  const conversation = await apiCall(port(), `/api/creator-accounts/${accountId}/conversations`, {
    token: tenantA.owner.token,
    body: {
      fanId: fan.body['fanId'] as string,
      channel: 'dm',
      topic: 'authz-probe',
      attributes: {},
      idempotencyKey: 'authz-conversation-1',
    },
  });
  assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
  conversationA = conversation.body['conversationId'] as string;

  // Publish the frozen pack manifest (the install route's fixture).
  const publish = await apiCall(port(), '/api/creator-operations/publish', {
    token: tenantA.owner.token,
    body: { idempotencyKey: 'authz-pack-publish-1' },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  packId = publish.body['packId'] as string;
});

after(async () => {
  await db?.close();
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
// WORKSPACE SCOPING — the pack's workspace-scoped surfaces
// ---------------------------------------------------------------------------

test('workspace scoping: the pack TaskProfiles provision and the domain-pack install are workspace-scoped; a foreign workspace is the UNIFORM 404; a second same-client workspace IS reachable', async () => {
  // The owner provisions the pack's TaskProfiles into the tenant's own
  // workspace (201 — the pack receipts come back workspace-scoped).
  const own = await apiCall(
    port(),
    `/api/workspaces/${tenantA.workspaceId}/creator-operations/task-profiles`,
    {
      token: tenantA.owner.token,
      body: { idempotencyKey: 'authz-provision-own-1' },
    },
  );
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const receipts = own.body['taskProfiles'] as { taskClass: string; taskProfileId: string }[];
  assert.ok(receipts.length >= 1, 'the pack task profiles were provisioned');

  // A SECOND workspace of the SAME client is reachable by the same owner
  // (a Workspace is an organizational boundary INSIDE one Client — the
  // ownership chain resolves through the same agency; scope ≠ membership).
  const second = await apiCall(
    port(),
    `/api/workspaces/${workspaceA2}/creator-operations/task-profiles`,
    {
      token: tenantA.owner.token,
      body: { idempotencyKey: 'authz-provision-second-1' },
    },
  );
  assert.equal(
    second.status,
    201,
    `the same-client second workspace is reachable: ${JSON.stringify(second.body)}`,
  );
  const secondReceipts = second.body['taskProfiles'] as { taskClass: string; taskProfileId: string }[];
  assert.ok(secondReceipts.length >= 1);

  // The pack install route: same-client second workspace reachable.
  const installSecond = await apiCall(
    port(),
    `/api/workspaces/${workspaceA2}/domain-pack-installs`,
    {
      token: tenantA.owner.token,
      body: { packId, idempotencyKey: 'authz-install-second-1' },
    },
  );
  assert.equal(installSecond.status, 201, JSON.stringify(installSecond.body));

  // A FOREIGN workspace (a Client of ANOTHER agency): the owner of agency
  // A gets the UNIFORM 404 on BOTH workspace-scoped pack surfaces —
  // indistinguishable from an unknown identifier (no cross-tenant oracle).
  // (Both identifiers are VALID UUIDs — the frozen uniform-404 vocabulary;
  // the malformed non-UUID behavior of these merged routes is pre-existing
  // and out of MKT-039's composition scope.)
  const foreignProvision = await apiCall(
    port(),
    `/api/workspaces/${tenantB.workspaceId}/creator-operations/task-profiles`,
    {
      token: tenantA.owner.token,
      body: { idempotencyKey: 'authz-provision-foreign-1' },
    },
  );
  const unknownProvision = await apiCall(
    port(),
    '/api/workspaces/00000000-0000-4000-8000-000000000000/creator-operations/task-profiles',
    {
      token: tenantA.owner.token,
      body: { idempotencyKey: 'authz-provision-unknown-1' },
    },
  );
  assert.equal(foreignProvision.status, 404, `foreign workspace must 404: ${JSON.stringify(foreignProvision.body)}`);
  assert.equal(unknownProvision.status, 404);
  assert.equal(foreignProvision.status, unknownProvision.status, 'foreign ≡ unknown (no oracle)');

  const foreignInstall = await apiCall(
    port(),
    `/api/workspaces/${tenantB.workspaceId}/domain-pack-installs`,
    {
      token: tenantA.owner.token,
      body: { packId, idempotencyKey: 'authz-install-foreign-1' },
    },
  );
  const unknownInstall = await apiCall(
    port(),
    '/api/workspaces/00000000-0000-4000-8000-000000000000/domain-pack-installs',
    {
      token: tenantA.owner.token,
      body: { packId, idempotencyKey: 'authz-install-unknown-1' },
    },
  );
  assert.equal(foreignInstall.status, 404);
  assert.equal(unknownInstall.status, 404);
  assert.equal(foreignInstall.status, unknownInstall.status, 'foreign ≡ unknown (no oracle)');

  // The foreign tenant's task profiles never landed in agency A's
  // workspaces (the provisioning writes are scoped server-side).
  const aWorkspaceProfiles = await db!.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM ai_task_profiles WHERE workspace_id = $1',
    [tenantA.workspaceId],
  );
  const aSecondProfiles = await db!.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM ai_task_profiles WHERE workspace_id = $1',
    [workspaceA2],
  );
  const bWorkspaceProfiles = await db!.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM ai_task_profiles WHERE workspace_id = $1',
    [tenantB.workspaceId],
  );
  assert.equal(Number(bWorkspaceProfiles.rows[0]!.count), 0, 'nothing was provisioned into the foreign workspace');
  assert.ok(Number(aWorkspaceProfiles.rows[0]!.count) >= 1);
  assert.ok(Number(aSecondProfiles.rows[0]!.count) >= 1);

  // No install row landed for the foreign workspace either.
  const bInstalls = await db!.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM domain_pack_installs WHERE workspace_id = $1',
    [tenantB.workspaceId],
  );
  assert.equal(Number(bInstalls.rows[0]!.count), 0);
});

// ---------------------------------------------------------------------------
// ROLE/AUTHORITY ENFORCEMENT — the pack guards (owner|admin mutations,
// any-active-member reads)
// ---------------------------------------------------------------------------

test('role enforcement: pack MUTATIONS demand owner|admin (operator/collaborator 403); pack READS serve any active member; a foreign agency member is the uniform 404 on reads', async () => {
  // --- MUTATIONS: the agency_operator is 403 (insufficient role) --------
  const operatorProfile = await apiCall(port(), `/api/clients/${tenantA.clientId}/creator-profiles`, {
    token: operatorA.token,
    body: {
      displayName: 'Operator Probe',
      handle: 'operator-probe',
      niches: ['fitness'],
      bio: 'must never land',
      attributes: {},
      idempotencyKey: 'authz-operator-profile-1',
    },
  });
  assert.equal(operatorProfile.status, 403, `the operator must not mutate pack subjects: ${JSON.stringify(operatorProfile.body)}`);

  const operatorSend = await apiCall(port(), `/api/creator-conversations/${conversationA}/messages/outbound`, {
    token: operatorA.token,
    body: { body: 'never', idempotencyKey: 'authz-operator-send-1', approvalId: null },
  });
  assert.equal(operatorSend.status, 403);

  const operatorObservation = await apiCall(port(), `/api/clients/${tenantA.clientId}/creator-observations`, {
    token: operatorA.token,
    body: {
      subjectKind: 'conversation',
      subjectRef: conversationA,
      eventKind: 'message_sent',
      content: {},
      observedAt: new Date().toISOString(),
      quality: 'C',
      metric: null,
      idempotencyKey: 'authz-operator-observation-1',
    },
  });
  assert.equal(operatorObservation.status, 403);

  const operatorProvision = await apiCall(
    port(),
    `/api/workspaces/${tenantA.workspaceId}/creator-operations/task-profiles`,
    {
      token: operatorA.token,
      body: { idempotencyKey: 'authz-operator-provision-1' },
    },
  );
  assert.equal(operatorProvision.status, 403);

  // --- MUTATIONS: the client_collaborator is 403 (insufficient role) ----
  const collaboratorProfile = await apiCall(port(), `/api/clients/${tenantA.clientId}/creator-profiles`, {
    token: collaboratorA.token,
    body: {
      displayName: 'Collaborator Probe',
      handle: 'collaborator-probe',
      niches: ['fitness'],
      bio: 'must never land',
      attributes: {},
      idempotencyKey: 'authz-collab-profile-1',
    },
  });
  assert.equal(collaboratorProfile.status, 403, `the collaborator must not mutate pack subjects: ${JSON.stringify(collaboratorProfile.body)}`);

  const collaboratorApproval = await apiCall(port(), `/api/creator-conversations/${conversationA}/approvals`, {
    token: collaboratorA.token,
    body: { decision: 'approved', notes: '', idempotencyKey: 'authz-collab-approval-1' },
  });
  assert.equal(collaboratorApproval.status, 403);

  // --- READS: any ACTIVE member of the owning agency (collaborator) -----
  const collaboratorRead = await apiCall(port(), `/api/creator-conversations/${conversationA}`, {
    token: collaboratorA.token,
  });
  assert.equal(collaboratorRead.status, 200, `the collaborator may read pack subjects: ${JSON.stringify(collaboratorRead.body)}`);

  const collaboratorList = await apiCall(port(), `/api/clients/${tenantA.clientId}/creator-profiles`, {
    token: collaboratorA.token,
  });
  assert.equal(collaboratorList.status, 200);

  // --- READS: a FOREIGN agency's member is the uniform 404 --------------
  const foreignRead = await apiCall(port(), `/api/creator-conversations/${conversationA}`, {
    token: tenantB.owner.token,
  });
  const unknownRead = await apiCall(port(), '/api/creator-conversations/00000000-0000-4000-8000-000000000000', {
    token: tenantB.owner.token,
  });
  assert.equal(foreignRead.status, 404);
  assert.equal(unknownRead.status, 404);
  assert.equal(foreignRead.status, unknownRead.status, 'a foreign pack subject is indistinguishable from an unknown one');

  // --- nothing was written by any rejected mutation ---------------------
  const profileCount = await db!.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM creator_profiles WHERE handle IN ('operator-probe', 'collaborator-probe')",
  );
  assert.equal(Number(profileCount.rows[0]!.count), 0, 'zero pack profiles were written by the rejected mutations');
  const approvalCount = await db!.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM creator_operation_approvals WHERE resource_id = $1',
    [conversationA],
  );
  assert.equal(Number(approvalCount.rows[0]!.count), 0, 'zero approval rows were written by the rejected mutations');
});

// ---------------------------------------------------------------------------
// CROSS-CLIENT 404 — every pack subject surface (read + gated send +
// approval history)
// ---------------------------------------------------------------------------

test('cross-client 404: a foreign pack subject is indistinguishable from an unknown one on every subject surface', async () => {
  const foreignSubjectRead = await apiCall(port(), `/api/creator-profiles/${profileA}`, {
    token: tenantB.owner.token,
  });
  const unknownSubjectRead = await apiCall(port(), '/api/creator-profiles/00000000-0000-4000-8000-000000000000', {
    token: tenantB.owner.token,
  });
  assert.equal(foreignSubjectRead.status, 404);
  assert.equal(unknownSubjectRead.status, 404);

  const foreignConversationRead = await apiCall(port(), `/api/creator-conversations/${conversationA}`, {
    token: tenantB.owner.token,
  });
  const unknownConversationRead = await apiCall(
    port(),
    '/api/creator-conversations/00000000-0000-4000-8000-000000000000',
    { token: tenantB.owner.token },
  );
  assert.equal(foreignConversationRead.status, 404);
  assert.equal(unknownConversationRead.status, 404);

  // The gated send and the approval history under the foreign principal:
  // the ownership fence fires BEFORE any module work (no partial writes,
  // no policy evaluation for a foreign caller).
  const foreignSend = await apiCall(port(), `/api/creator-conversations/${conversationA}/messages/outbound`, {
    token: tenantB.owner.token,
    body: { body: 'cross-tenant send probe', idempotencyKey: 'authz-foreign-send-1', approvalId: null },
  });
  assert.equal(foreignSend.status, 404, `the foreign send is fenced at the boundary: ${JSON.stringify(foreignSend.body)}`);
  const foreignApprovals = await apiCall(port(), `/api/creator-conversations/${conversationA}/approvals`, {
    token: tenantB.owner.token,
  });
  assert.equal(foreignApprovals.status, 404);

  // A foreign APPROVAL id under an authorized path is equally a 404 (no
  // cross-tenant oracle on the approval reference).
  const foreignApprovalSend = await apiCall(port(), `/api/creator-conversations/${conversationA}/messages/outbound`, {
    token: tenantA.owner.token,
    body: { body: 'probe', idempotencyKey: 'authz-foreign-approval-1', approvalId: '00000000-0000-4000-8000-000000000000' },
  });
  assert.equal(foreignApprovalSend.status, 404);

  // Zero outbound rows landed from any probe.
  const outboundCount = await db!.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM creator_conversation_messages WHERE direction = 'outbound'",
  );
  assert.equal(Number(outboundCount.rows[0]!.count), 0, 'no outbound row was ever written');
});

// ---------------------------------------------------------------------------
// THE FROZEN PACK GUARDS — material keys and authority-shaped DTO keys
// ---------------------------------------------------------------------------

test('pack guards: a material-shaped payload key and an authority-shaped DTO key are each rejected 422 with ZERO rows', async () => {
  // A material-shaped key at ANY nesting level (§21/CRED-001).
  const material = await apiCall(port(), `/api/clients/${tenantA.clientId}/creator-observations`, {
    token: tenantA.owner.token,
    body: {
      subjectKind: 'conversation',
      subjectRef: conversationA,
      eventKind: 'message_sent',
      content: { nested: { apiKey: 'leak-attempt' } },
      observedAt: new Date().toISOString(),
      quality: 'C',
      metric: null,
      idempotencyKey: 'authz-guard-material-1',
    },
  });
  assert.equal(material.status, 422, `the §21 guard must reject nested material keys: ${JSON.stringify(material.body)}`);

  // An authority-shaped DTO key (scope is server-derived — never
  // request-suppliable).
  const authorityField = await apiCall(port(), `/api/creator-conversations/${conversationA}/messages/outbound`, {
    token: tenantA.owner.token,
    body: {
      body: 'probe',
      idempotencyKey: 'authz-guard-authority-1',
      approvalId: null,
      policyDecisionId: 'forged-decision-id',
    },
  });
  assert.equal(
    authorityField.status,
    422,
    `the authority-shaped DTO key must be rejected: ${JSON.stringify(authorityField.body)}`,
  );

  // Nothing was written by either rejected command.
  const evidenceCount = await db!.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM evidence WHERE content::text LIKE '%leak-attempt%'",
  );
  assert.equal(Number(evidenceCount.rows[0]!.count), 0, 'no evidence row carries the material key');
  const outboundCount = await db!.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM creator_conversation_messages WHERE direction = 'outbound'",
  );
  assert.equal(Number(outboundCount.rows[0]!.count), 0, 'no outbound row was written');
});
