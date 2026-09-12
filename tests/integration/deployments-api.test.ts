/**
 * MKT-040 integration tests — the Marketing Cloud Deployment control
 * plane (DEPLOY-002) on the real stack (embedded PostgreSQL 18 + a real
 * API process + the loopback sandbox provider for the integration
 * capability — no mocks of platform services).
 *
 * Acceptance mapping (spec/requirements-v1.4.md DEPLOY-AC-03..09 — the
 * binding behavioral list; the unit file carries the pure gate core, the
 * architecture file the static proofs):
 *
 *   - DEPLOY-AC-03 (identity): a deployment created through the API
 *     persists the FULL frozen identity — Agency/Client/Workspace scope
 *     (server-derived), pinned immutable playbook version, resolved
 *     workflow version references, required Domain Pack versions,
 *     required Integration/Extension capabilities, policy reference,
 *     runtime requirements, trigger configuration, lifecycle state +
 *     CAS version — verified BOTH through the API response AND the raw
 *     SQL row, with the 'created' ledger revision carrying the selection
 *     snapshot and server-derived provenance;
 *   - DEPLOY-AC-04 (activation gate): the golden path (validate → ready
 *     with every named check green → activate → active), then EVERY
 *     dependency failure (pack install disabled, extension install
 *     unauthorized, connection suspended, credential disabled, policy
 *     deny, playbook retired) REFUSES the transition with the failed
 *     checks and the deployment NEVER reaches ACTIVE (stays ready, zero
 *     'activated' ledger rows);
 *   - DEPLOY-AC-05 (state/concurrency): invalid lifecycle transitions
 *     are rejected (every non-edge probed), terminal states reject
 *     everything, material mutations are IDEMPOTENT (duplicate
 *     idempotency keys converge to the recorded event — no second row,
 *     no version bump) and CAS conflicts reject stale versions;
 *   - DEPLOY-AC-06 (history immutability): after an execution, an
 *     evidence observation and a learning record exist as history,
 *     redeploy + rollback change the deployment's FUTURE version
 *     selection while the historical Execution/Outcome (transition)/
 *     Evidence/Learning rows stay byte-identical; the DB rejects direct
 *     UPDATEs on the ledger and on selection columns outside the
 *     completion edges;
 *   - DEPLOY-AC-08 (client isolation): a foreign deployment under
 *     another Workspace path is the SAME uniform 404 as an unknown id;
 *     cross-client binding attempts (foreign playbook version, foreign
 *     workspace's workflow definition) are rejected before any write;
 *   - DEPLOY-AC-09 (runtime neutrality): all four runtime classes are
 *     declarable and persistable, the requested executions carry the
 *     DECLARED class, no infrastructure identity column exists and the
 *     DB CHECK rejects infra-shaped runtime requirements outright.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
} from './helpers/harness.ts';
import { startSandboxProvider, type SandboxProvider } from './helpers/sandbox-provider.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const META_TOKEN = 'mkt040-meta-provider-token';

let stack: IntegrationStack | null = null;
let sandbox: SandboxProvider | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let db: PgDb | null = null;

let adminTokenValue = '';
let ownerAToken = '';
let agencyAId = '';
let clientAId = '';
let workspaceAId = '';
let ownerBToken = '';
let agencyBId = '';
let clientBId = '';
let workspaceBId = '';

let playbookAId = '';
let playbookVersionV1Id = '';
let playbookVersionV2Id = '';
let workflowAId = '';
let workflowADefV1Id = '';
let workflowADefV2Id = '';
let packId = '';
let extensionId = '';
let extensionInstallId = '';
let packInstallId = '';
let credentialAId = '';
let connectionAId = '';

// The immutable selection fixture (v1) every golden deployment pins.
interface Selection {
  playbookVersionId: string;
  workflowDefinitionIds: string[];
  requiredDomainPacks: Record<string, unknown>[];
  requiredCapabilities: Record<string, unknown>[];
  runtimeRequirements: { runtimeClass: string };
  triggerConfig: Record<string, unknown>[];
}

function selectionV1(runtimeClass = 'pooled-worker'): Selection {
  return {
    playbookVersionId: playbookVersionV1Id,
    workflowDefinitionIds: [workflowADefV1Id],
    requiredDomainPacks: [{ name: 'mkt040-test-pack', versionConstraint: '^1.0.0' }],
    requiredCapabilities: [
      { kind: 'extension', name: 'mkt040-email-composer', versionConstraint: '^1.0.0' },
      { kind: 'integration', name: 'meta-ads', versionConstraint: null },
    ],
    runtimeRequirements: { runtimeClass },
    triggerConfig: [
      { kind: 'manual', config: null },
      { kind: 'schedule', config: { cron: '0 9 * * 1' } },
    ],
  };
}

function selectionV2(): Selection {
  return {
    playbookVersionId: playbookVersionV2Id,
    workflowDefinitionIds: [workflowADefV2Id],
    requiredDomainPacks: [{ name: 'mkt040-test-pack', versionConstraint: '^1.0.0' }],
    requiredCapabilities: [
      { kind: 'extension', name: 'mkt040-email-composer', versionConstraint: '^1.0.0' },
      { kind: 'integration', name: 'meta-ads', versionConstraint: null },
    ],
    runtimeRequirements: { runtimeClass: 'ephemeral-sandbox' },
    triggerConfig: [{ kind: 'manual', config: null }],
  };
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

/** The pipeline nests typed application errors under an `error` key. */
function errorBody(response: { readonly body: Record<string, unknown> }): Record<string, unknown> {
  const nested = response.body['error'];
  return (nested !== null && typeof nested === 'object' ? nested : response.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function adminToken(): Promise<string> {
  if (adminTokenValue !== '') return adminTokenValue;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  adminTokenValue = login.body['token'] as string;
  return adminTokenValue;
}

async function makePrincipal(email: string): Promise<{ token: string; agencyId: string }> {
  const admin = await adminToken();
  const user = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(user.status, 201);
  const userId = user.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'a-very-long-password-123' },
  });
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email.split('@')[0]}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: 'a-very-long-password-123' },
  });
  assert.equal(login.status, 200);
  return { token: login.body['token'] as string, agencyId };
}

async function makeClientAndWorkspace(agencyId: string, token: string, label: string) {
  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name: `Client ${label}` },
  });
  assert.equal(client.status, 201);
  const clientId = client.body['clientId'] as string;
  const workspace = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token,
    body: { name: `Workspace ${label}` },
  });
  assert.equal(workspace.status, 201, JSON.stringify(workspace.body));
  return { clientId, workspaceId: workspace.body['workspaceId'] as string };
}

async function declarePlatformPolicy(dimension: string): Promise<void> {
  const declared = await apiCall(port(), '/api/policies', {
    token: await adminToken(),
    body: {
      dimension,
      rules: [
        {
          effect: 'allow',
          operations: ['*'],
          reason: 'MKT-040 integration-test platform boundary: explicit allow',
        },
      ],
      description: `MKT-040 integration-test platform default (${dimension})`,
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

const emptySchema = { type: 'object', properties: {}, required: [] };

function functionNode(nodeId: string): Record<string, unknown> {
  return {
    nodeId,
    nodeType: 'function',
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string' } }, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
  };
}

function terminalNode(nodeId: string): Record<string, unknown> {
  return { ...functionNode(nodeId), nodeType: 'terminal' };
}

function successEdge(fromNode: string, toNode: string): Record<string, unknown> {
  return { fromNode, toNode, edgeType: 'success', predicateRef: null, joinSemantics: null };
}

function minimalWorkflowContent(): Record<string, unknown> {
  return {
    graph: { nodes: [functionNode('a'), terminalNode('t')], edges: [successEdge('a', 't')] },
    inputSchema: { ...emptySchema },
    outputSchema: { ...emptySchema },
    retryPolicyDefaults: {},
    concurrencyLimits: {},
    timeoutPolicy: {},
    compensation: [],
  };
}

async function makePlaybookWithVersions(clientId: string, token: string): Promise<void> {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token,
    body: { name: 'MKT-040 Launch Playbook', description: 'The deployment fixture playbook.' },
  });
  assert.equal(playbook.status, 201, JSON.stringify(playbook.body));
  playbookAId = playbook.body['playbookId'] as string;

  for (const [suffix] of [
    ['v1'],
    ['v2'],
  ] as const) {
    const version = await apiCall(port(), `/api/playbooks/${playbookAId}/versions`, {
      token,
      body: {
        strategy: {
          summary: `MKT-040 strategy ${suffix}`,
          templates: [{ name: 'SEO', description: 'Programmatic topic clusters' }],
        },
        deploymentMetadata: {
          requiredDomainPacks: [{ name: 'mkt040-test-pack', versionConstraint: '^1.0.0' }],
          requiredCapabilities: [
            { kind: 'extension', name: 'mkt040-email-composer', versionConstraint: '^1.0.0' },
            { kind: 'integration', name: 'meta-ads' },
          ],
          runtimeRequirements: { runtimeClass: 'pooled-worker' },
          triggers: [{ kind: 'manual' }, { kind: 'schedule', config: { cron: '0 9 * * 1' } }],
        },
      },
    });
    assert.equal(version.status, 201, JSON.stringify(version.body));
    const versionId = version.body['versionId'] as string;
    // The frozen playbook version lifecycle: draft → review → published.
    const review = await apiCall(
      port(),
      `/api/playbooks/${playbookAId}/versions/${versionId}/status`,
      { token, method: 'PATCH', body: { status: 'review', version: 1 } },
    );
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const published = await apiCall(
      port(),
      `/api/playbooks/${playbookAId}/versions/${versionId}/status`,
      { token, method: 'PATCH', body: { status: 'published', version: 2 } },
    );
    assert.equal(published.status, 200, JSON.stringify(published.body));
    if (suffix === 'v1') playbookVersionV1Id = versionId;
    else playbookVersionV2Id = versionId;
  }
}

async function makeWorkflowWithDefinitions(workspaceId: string, token: string): Promise<void> {
  const workflow = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token,
    body: { name: 'MKT-040 Launch Workflow', description: 'The deployment fixture workflow.' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  workflowAId = workflow.body['workflowId'] as string;

  for (const [index, playbookVersionId] of [
    [1, playbookVersionV1Id],
    [2, playbookVersionV2Id],
  ] as const) {
    const definition = await apiCall(port(), `/api/workflows/${workflowAId}/definitions`, {
      token,
      body: { ...minimalWorkflowContent(), playbookVersionId },
    });
    assert.equal(definition.status, 201, JSON.stringify(definition.body));
    const definitionId = definition.body['workflowDefinitionId'] as string;
    // The frozen workflow definition lifecycle: draft -> review -> active.
    for (const [status, version] of [['review', 1], ['active', 2]] as const) {
      const transition = await apiCall(
        port(),
        `/api/workflows/${workflowAId}/definitions/${definitionId}/status`,
        { token, method: 'PATCH', body: { status, version } },
      );
      assert.equal(transition.status, 200, JSON.stringify(transition.body));
    }
    if (index === 1) workflowADefV1Id = definitionId;
    else workflowADefV2Id = definitionId;
  }
}

async function makeDomainPack(token: string): Promise<void> {
  const publish = await apiCall(port(), '/api/domain-packs', {
    token,
    body: {
      manifest: {
        packKey: 'mkt040-test-pack',
        publisher: 'mkt040-labs',
        version: '1.1.0',
        displayName: 'MKT-040 Test Pack',
        description: 'The deployment fixture Domain Pack.',
        compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
        requiredPacks: [],
        artifacts: [
          {
            kind: 'domain-entity',
            name: 'launch-campaign',
            description: 'A launch campaign entity.',
            scope: 'client',
            payload: { fields: ['id', 'name'] },
          },
        ],
      },
      idempotencyKey: 'mkt040-pack-publish-1',
    },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  packId = publish.body['packId'] as string;

  const install = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/domain-pack-installs`,
    { token, body: { packId, idempotencyKey: 'mkt040-pack-install-1' } },
  );
  assert.equal(install.status, 201, JSON.stringify(install.body));
  packInstallId = (install.body['install'] as Record<string, unknown>)['installId'] as string;
}

async function makeExtension(agencyId: string, token: string): Promise<void> {
  const register = await apiCall(port(), '/api/extensions', {
    token,
    body: {
      manifest: {
        extensionKey: 'mkt040-email-composer',
        publisher: 'mkt040-labs',
        version: '1.0.2',
        compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
        capabilities: [{ category: 'data-source', name: 'compose-email' }],
        permissions: [{ action: 'data:read' }, { action: 'secret:use' }],
        requiredSecretNames: ['EMAIL_API_KEY'],
        dataScopes: ['client:read', 'workspace:read'],
        networkRequirements: [],
        runtimeClass: 'pooled-worker',
        inputContract: { required: ['audienceId'] },
        outputContract: { required: ['composedCount'] },
        eventSubscriptions: [],
        uiSurfaces: [],
        configContract: {
          region: {
            type: 'string',
            required: true,
            description: 'The composer region',
            pattern: '^(eu|us)$',
          },
        },
      },
      idempotencyKey: 'mkt040-extension-register-1',
    },
  });
  assert.equal(register.status, 201, JSON.stringify(register.body));
  extensionId = register.body['extensionId'] as string;

  const install = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/extension-installs`,
    {
      token,
      body: {
        extensionId,
        grantedScopes: ['client:read', 'workspace:read'],
        idempotencyKey: 'mkt040-extension-install-1',
      },
    },
  );
  assert.equal(install.status, 201, JSON.stringify(install.body));
  extensionInstallId = (install.body['install'] as Record<string, unknown>)['installId'] as string;
  const installVersion = (install.body['install'] as Record<string, unknown>)['version'] as number;

  const configure = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/extension-installs/${extensionInstallId}/configure`,
    {
      token,
      body: {
        config: { region: 'eu' },
        secretBindings: { EMAIL_API_KEY: credentialAId },
        expectedVersion: installVersion,
      },
    },
  );
  assert.equal(configure.status, 200, JSON.stringify(configure.body));
  // The configure route responds with the flattened install record.
  const configuredVersion = configure.body['version'] as number;

  const authorize = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/extension-installs/${extensionInstallId}/authorize`,
    { token, body: { expectedVersion: configuredVersion } },
  );
  assert.equal(authorize.status, 200, JSON.stringify(authorize.body));
  assert.equal(authorize.body['status'], 'authorized');
}

async function makeCredential(agencyId: string, token: string, handle: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/credentials`, {
    token,
    body: { kind: 'integration_api_key', label: handle.replaceAll('-', '.'), secretHandle: handle },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['credentialId'] as string;
}

async function makeConnection(token: string, clientId: string): Promise<void> {
  const register = await apiCall(port(), `/api/clients/${clientId}/connections`, {
    token,
    body: {
      adapterKey: 'meta-ads',
      credentialReferenceId: credentialAId,
      providerConfig: { apiBaseUrl: `${sandbox!.url}/meta` },
    },
  });
  assert.equal(register.status, 201, JSON.stringify(register.body));
  connectionAId = register.body['connectionId'] as string;
  const version = register.body['version'] as number;
  const connect = await apiCall(
    port(),
    `/api/clients/${clientId}/connections/${connectionAId}/connect`,
    { token, body: { expectedVersion: version } },
  );
  assert.equal(connect.status, 200, JSON.stringify(connect.body));
  assert.equal(connect.body['status'], 'connected');
}

async function createDeployment(
  token: string,
  workspaceId: string,
  selection: Selection,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workspaces/${workspaceId}/deployments`, {
    token,
    body: { selection: selectionDto(selection) },
  });
}

/** The route DTO shape: absent optional keys instead of explicit nulls. */
function selectionDto(selection: Selection): Record<string, unknown> {
  return {
    playbookVersionId: selection.playbookVersionId,
    workflowDefinitionIds: selection.workflowDefinitionIds,
    requiredDomainPacks: selection.requiredDomainPacks.map((pack) =>
      pack['versionConstraint'] === null
        ? { name: pack['name'] }
        : { name: pack['name'], versionConstraint: pack['versionConstraint'] },
    ),
    requiredCapabilities: selection.requiredCapabilities.map((capability) =>
      capability['versionConstraint'] === null
        ? { kind: capability['kind'], name: capability['name'] }
        : {
            kind: capability['kind'],
            name: capability['name'],
            versionConstraint: capability['versionConstraint'],
          },
    ),
    runtimeRequirements: selection.runtimeRequirements,
    triggerConfig: selection.triggerConfig.map((trigger) =>
      trigger['config'] === null || trigger['config'] === undefined
        ? { kind: trigger['kind'] }
        : { kind: trigger['kind'], config: trigger['config'] },
    ),
  };
}

async function deploymentAction(
  token: string,
  workspaceId: string,
  deploymentId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(
    port(),
    `/api/workspaces/${workspaceId}/deployments/${deploymentId}/${action}`,
    { token, body },
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

before(async () => {
  stack = await bootStack('deployments');
  // The meta provider credential material (the connection probe carries
  // the accessToken against the loopback sandbox provider).
  fs.writeFileSync(
    path.join(stack.env.secretsDir, 'mkt040-meta-key.secret'),
    JSON.stringify({ accessToken: META_TOKEN, webhookSecret: null }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(stack.env.secretsDir, 'mkt040-email-key.secret'),
    'mkt040-email-material-not-a-secret-leak',
    { mode: 0o600 },
  );

  // The loopback provider for the integration capability (meta-ads).
  sandbox = await startSandboxProvider({ meta: META_TOKEN });

  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // Platform policy defaults: the fail-closed dimensions my flows rely on.
  await declarePlatformPolicy('deployment');
  await declarePlatformPolicy('extension');
  await declarePlatformPolicy('network');
  await declarePlatformPolicy('secrets');

  const ownerA = await makePrincipal('alex@deployments.test');
  ownerAToken = ownerA.token;
  agencyAId = ownerA.agencyId;
  const a = await makeClientAndWorkspace(agencyAId, ownerAToken, 'Alpha');
  clientAId = a.clientId;
  workspaceAId = a.workspaceId;

  const ownerB = await makePrincipal('blake@deployments.test');
  ownerBToken = ownerB.token;
  agencyBId = ownerB.agencyId;
  const b = await makeClientAndWorkspace(agencyBId, ownerBToken, 'Beta');
  clientBId = b.clientId;
  workspaceBId = b.workspaceId;

  credentialAId = await makeCredential(agencyAId, ownerAToken, 'mkt040-meta-key');
  await makePlaybookWithVersions(clientAId, ownerAToken);
  await makeWorkflowWithDefinitions(workspaceAId, ownerAToken);
  await makeDomainPack(ownerAToken);
  await makeExtension(agencyAId, ownerAToken);
  await makeConnection(ownerAToken, clientAId);

  // The in-process SQL probe connection (DB backstop assertions).
  db = new PgDb(stack.env.databaseUrl, 2);
});

after(async () => {
  await db?.close();
  await sandbox?.close();
  if (api !== null) api.child.kill('SIGKILL');
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// DEPLOY-AC-03 — the deployment identity (DB/API contract)
// ---------------------------------------------------------------------------

test('DEPLOY-AC-03 ROUTE+DB: creating a deployment persists the full frozen identity', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const record = created.body as Record<string, unknown>;
  const deploymentId = record['deploymentId'] as string;
  assert.equal(record['agencyId'], agencyAId);
  assert.equal(record['clientId'], clientAId);
  assert.equal(record['workspaceId'], workspaceAId);
  assert.equal(record['playbookVersionId'], playbookVersionV1Id);
  assert.deepEqual(record['workflowDefinitionIds'], [workflowADefV1Id]);
  assert.deepEqual(record['requiredDomainPacks'], [
    { name: 'mkt040-test-pack', versionConstraint: '^1.0.0' },
  ]);
  assert.deepEqual(record['requiredCapabilities'], [
    { kind: 'extension', name: 'mkt040-email-composer', versionConstraint: '^1.0.0' },
    { kind: 'integration', name: 'meta-ads', versionConstraint: null },
  ]);
  assert.ok(typeof record['policyReferenceId'] === 'string');
  assert.deepEqual(record['runtimeRequirements'], { runtimeClass: 'pooled-worker' });
  assert.equal((record['triggerConfig'] as unknown[]).length, 2);
  assert.equal(record['status'], 'draft');
  assert.equal(record['version'], 1);
  assert.ok(typeof record['createdAt'] === 'string');

  // The raw SQL row carries the same frozen identity.
  const rows = await db!.query<{
    agency_id: string;
    client_id: string;
    workspace_id: string;
    playbook_version_id: string;
    workflow_definition_ids: string[];
    status: string;
    version: string;
    runtime_requirements: { runtimeClass: string };
    trigger_config: unknown[];
  }>(
    `SELECT agency_id, client_id, workspace_id, playbook_version_id,
            workflow_definition_ids, status, version, runtime_requirements, trigger_config
     FROM deployments WHERE deployment_id = $1`,
    [deploymentId],
  );
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0]!;
  assert.equal(row.agency_id, agencyAId);
  assert.equal(row.client_id, clientAId);
  assert.equal(row.workspace_id, workspaceAId);
  assert.equal(row.playbook_version_id, playbookVersionV1Id);
  assert.deepEqual(row.workflow_definition_ids, [workflowADefV1Id]);
  assert.equal(row.status, 'draft');
  assert.equal(Number(row.version), 1);
  assert.deepEqual(row.runtime_requirements, { runtimeClass: 'pooled-worker' });
  assert.equal((row.trigger_config as unknown[]).length, 2);

  // The 'created' ledger revision carries the selection snapshot + the
  // server-derived provenance block.
  const events = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/${deploymentId}/events`,
    { token: ownerAToken },
  );
  assert.equal(events.status, 200);
  const eventList = events.body['events'] as Record<string, unknown>[];
  assert.equal(eventList.length, 1);
  assert.equal(eventList[0]!['eventType'], 'created');
  assert.equal(eventList[0]!['toStatus'], 'draft');
  assert.ok((eventList[0]!['selection'] as Record<string, unknown>)['playbookVersionId']);
  const provenance = eventList[0]!['provenance'] as Record<string, unknown>;
  assert.equal(provenance['recordedVia'], 'api');
  assert.ok(typeof provenance['correlationId'] === 'string');
  assert.ok(typeof provenance['recordedAt'] === 'string');
});

test('DEPLOY-AC-03 ROUTE: authority-field smuggling on the create DTO is a 422', async () => {
  const smuggled = await apiCall(port(), `/api/workspaces/${workspaceAId}/deployments`, {
    token: ownerAToken,
    body: {
      selection: selectionDto(selectionV1()),
      status: 'active',
      version: 42,
      provenance: { actor: 'forged' },
    },
  });
  assert.equal(smuggled.status, 422);
  const created = await apiCall(port(), `/api/workspaces/${workspaceAId}/deployments`, {
    token: ownerAToken,
    body: {
      selection: {
        ...selectionDto(selectionV1()),
        runtimeRequirements: { runtimeClass: 'pooled-worker', region: 'eu-west-1' },
      },
    },
  });
  assert.equal(created.status, 422);
  const failure = errorBody(created);
  assert.match(
    `${String(failure['message'])} | ${((failure['details'] as string[]) ?? []).join(' | ')}`,
    /runtimeClass|infrastructure|region: unknown field/,
  );
});

// ---------------------------------------------------------------------------
// The golden path (shared by later tests)
// ---------------------------------------------------------------------------

interface GoldenDeployment {
  deploymentId: string;
  version: number;
}

async function goldenDeployment(runtimeClass = 'pooled-worker'): Promise<GoldenDeployment> {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1(runtimeClass));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const deploymentId = created.body['deploymentId'] as string;
  let version = created.body['version'] as number;

  const validated = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: `validate-${deploymentId}`,
    expectedVersion: version,
  });
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  version = ((validated.body['deployment'] as Record<string, unknown>)['version']) as number;

  const activated = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'activate', {
    idempotencyKey: `activate-${deploymentId}`,
    expectedVersion: version,
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  version = ((activated.body['deployment'] as Record<string, unknown>)['version']) as number;
  return { deploymentId, version };
}

test('DEPLOY-AC-04 ROUTE: the golden path — validate records every green check, activate gates into ACTIVE', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const deploymentId = created.body['deploymentId'] as string;

  const validated = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: `validate-golden-${deploymentId}`,
    expectedVersion: 1,
  });
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  const deployment = validated.body['deployment'] as Record<string, unknown>;
  assert.equal(deployment['status'], 'ready');
  const event = validated.body['event'] as Record<string, unknown>;
  assert.equal(event['eventType'], 'validated');
  assert.equal(event['fromStatus'], 'draft');
  assert.equal(event['toStatus'], 'ready');
  const report = event['validationReport'] as Record<string, unknown>;
  assert.equal(report['ok'], true);
  const checks = report['checks'] as Record<string, unknown>[];
  assert.equal(checks.length, 9);
  for (const name of [
    'authorization',
    'playbook-version',
    'workflow-versions',
    'domain-packs',
    'capabilities',
    'credentials',
    'policy',
    'runtime',
    'triggers',
  ]) {
    assert.ok(
      checks.some((check) => check['check'] === name && check['ok'] === true),
      `the '${name}' check is present and green`,
    );
  }
  // The row passed THROUGH the validating leg (never externally
  // targetable): the final status is ready and version advanced by 2.
  assert.equal(deployment['version'], 3);

  const activated = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'activate', {
    idempotencyKey: `activate-golden-${deploymentId}`,
    expectedVersion: 3,
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal((activated.body['deployment'] as Record<string, unknown>)['status'], 'active');
  const activatedEvent = activated.body['event'] as Record<string, unknown>;
  assert.equal(activatedEvent['eventType'], 'activated');
  assert.equal(activatedEvent['fromStatus'], 'ready');
  assert.ok((activatedEvent['validationReport'] as Record<string, unknown>)['ok'] === true);
  // The activated revision snapshot (the rollback target chain).
  assert.ok(
    ((activatedEvent['selection'] as Record<string, unknown>)['playbookVersionId']) === playbookVersionV1Id,
  );
});

// ---------------------------------------------------------------------------
// DEPLOY-AC-04 — the activation gate refuses every dependency failure
// ---------------------------------------------------------------------------

test('DEPLOY-AC-04 ROUTE: a disabled Domain Pack install refuses activation (stays ready, never ACTIVE)', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  const deploymentId = created.body['deploymentId'] as string;
  await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: `validate-pack-${deploymentId}`,
    expectedVersion: 1,
  });

  await db!.query(`UPDATE domain_pack_installs SET status = 'disabled' WHERE install_id = $1`, [
    packInstallId,
  ]);
  try {
    const activation = await deploymentAction(
      ownerAToken,
      workspaceAId,
      deploymentId,
      'activate',
      { idempotencyKey: `activate-pack-${deploymentId}`, expectedVersion: 3 },
    );
    assert.equal(activation.status, 422, JSON.stringify(activation.body));
    const failed = errorBody(activation);
    assert.match(String(failed['message']), /Deployment validation failed/);
    const details = (failed['details'] as string[]) ?? [];
    assert.ok(details.some((detail) => detail.startsWith('domain-packs:')), `details: ${details.join('|')}`);
  } finally {
    await db!.query(`UPDATE domain_pack_installs SET status = 'installed' WHERE install_id = $1`, [
      packInstallId,
    ]);
  }
  const read = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/${deploymentId}`,
    { token: ownerAToken },
  );
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['status'], 'ready');
  const events = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/${deploymentId}/events`,
    { token: ownerAToken },
  );
  const types = ((events.body['events'] as Record<string, unknown>[]).map((e) => e['eventType']));
  assert.ok(!types.includes('activated'), 'no activated ledger row exists');
});

test('DEPLOY-AC-04 ROUTE: an unauthorized extension install refuses activation', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  const deploymentId = created.body['deploymentId'] as string;
  await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: `validate-ext-${deploymentId}`,
    expectedVersion: 1,
  });

  await db!.query(`UPDATE extension_installs SET status = 'disabled' WHERE install_id = $1`, [
    extensionInstallId,
  ]);
  try {
    const activation = await deploymentAction(
      ownerAToken,
      workspaceAId,
      deploymentId,
      'activate',
      { idempotencyKey: `activate-ext-${deploymentId}`, expectedVersion: 3 },
    );
    assert.equal(activation.status, 422);
    const details = (errorBody(activation)['details'] as string[]) ?? [];
    assert.ok(details.some((detail) => detail.startsWith('capabilities:')));
  } finally {
    await db!.query(`UPDATE extension_installs SET status = 'authorized' WHERE install_id = $1`, [
      extensionInstallId,
    ]);
  }
  const read = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/${deploymentId}`,
    { token: ownerAToken },
  );
  assert.equal((read.body as Record<string, unknown>)['status'], 'ready');
});

test('DEPLOY-AC-04 ROUTE: a suspended integration connection refuses activation', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  const deploymentId = created.body['deploymentId'] as string;
  await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: `validate-conn-${deploymentId}`,
    expectedVersion: 1,
  });

  await db!.query(`UPDATE integration_connections SET status = 'suspended' WHERE connection_id = $1`, [
    connectionAId,
  ]);
  try {
    const activation = await deploymentAction(
      ownerAToken,
      workspaceAId,
      deploymentId,
      'activate',
      { idempotencyKey: `activate-conn-${deploymentId}`, expectedVersion: 3 },
    );
    assert.equal(activation.status, 422);
    const details = (errorBody(activation)['details'] as string[]) ?? [];
    assert.ok(details.some((detail) => detail.startsWith('capabilities:')));
  } finally {
    await db!.query(`UPDATE integration_connections SET status = 'connected' WHERE connection_id = $1`, [
      connectionAId,
    ]);
  }
});

test('DEPLOY-AC-04 ROUTE: a disabled credential reference refuses activation (drift re-checked at the gate)', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  const deploymentId = created.body['deploymentId'] as string;
  await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: `validate-cred-${deploymentId}`,
    expectedVersion: 1,
  });

  await db!.query(`UPDATE credential_references SET status = 'disabled' WHERE credential_id = $1`, [
    credentialAId,
  ]);
  try {
    const activation = await deploymentAction(
      ownerAToken,
      workspaceAId,
      deploymentId,
      'activate',
      { idempotencyKey: `activate-cred-${deploymentId}`, expectedVersion: 3 },
    );
    assert.equal(activation.status, 422);
    const details = (errorBody(activation)['details'] as string[]) ?? [];
    assert.ok(details.some((detail) => detail.startsWith('credentials:')));
  } finally {
    await db!.query(`UPDATE credential_references SET status = 'active' WHERE credential_id = $1`, [
      credentialAId,
    ]);
  }
  const read = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/${deploymentId}`,
    { token: ownerAToken },
  );
  assert.equal((read.body as Record<string, unknown>)['status'], 'ready');
});

test('DEPLOY-AC-04 ROUTE: a deployment-dimension policy DENY refuses activation (403, stays ready)', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  const deploymentId = created.body['deploymentId'] as string;
  await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: `validate-policy-${deploymentId}`,
    expectedVersion: 1,
  });

  const deny = await apiCall(port(), `/api/clients/${clientAId}/policies`, {
    token: ownerAToken,
    body: {
      dimension: 'deployment',
      rules: [
        { effect: 'deny', operations: ['*'], reason: 'MKT-040 negative: deny every deploy' },
      ],
      description: 'MKT-040 client-scoped deployment deny',
    },
  });
  assert.equal(deny.status, 201, JSON.stringify(deny.body));
  try {
    const activation = await deploymentAction(
      ownerAToken,
      workspaceAId,
      deploymentId,
      'activate',
      { idempotencyKey: `activate-policy-${deploymentId}`, expectedVersion: 3 },
    );
    assert.equal(activation.status, 403, JSON.stringify(activation.body));
    assert.equal(errorBody(activation)['code'], 'POLICY_DENIED');
  } finally {
    // Remove the deny: supersede with a client-scoped allow.
    const allow = await apiCall(port(), `/api/clients/${clientAId}/policies`, {
      token: ownerAToken,
      body: {
        dimension: 'deployment',
        rules: [
          { effect: 'allow', operations: ['*'], reason: 'MKT-040 negative cleanup: allow' },
        ],
        description: 'MKT-040 client-scoped deployment allow',
      },
    });
    assert.equal(allow.status, 201);
  }
  const read = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/${deploymentId}`,
    { token: ownerAToken },
  );
  assert.equal((read.body as Record<string, unknown>)['status'], 'ready');
});

test('DEPLOY-AC-04 ROUTE: a retired playbook version refuses even validation', async () => {
  // A second playbook + version that gets retired after creation of the
  // deployment pinning it.
  const playbook = await apiCall(port(), `/api/clients/${clientAId}/playbooks`, {
    token: ownerAToken,
    body: { name: 'MKT-040 Retire Playbook', description: 'negative fixture' },
  });
  const playbookId = playbook.body['playbookId'] as string;
  const version = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token: ownerAToken,
    body: {
      strategy: { summary: 'retire me', templates: [{ name: 'T', description: 't' }] },
      deploymentMetadata: {
        requiredDomainPacks: [],
        requiredCapabilities: [],
        runtimeRequirements: { runtimeClass: 'pooled-worker' },
        triggers: [{ kind: 'manual' }],
      },
    },
  });
  const versionId = version.body['versionId'] as string;
  for (const [status, version] of [['review', 1], ['published', 2]] as const) {
    const transition = await apiCall(
      port(),
      `/api/playbooks/${playbookId}/versions/${versionId}/status`,
      { token: ownerAToken, method: 'PATCH', body: { status, version } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
  }

  // A workflow definition pinning the retire-playbook version (the
  // immutable-version compatibility fixture).
  const retireDefinition = await apiCall(port(), `/api/workflows/${workflowAId}/definitions`, {
    token: ownerAToken,
    body: { ...minimalWorkflowContent(), playbookVersionId: versionId },
  });
  assert.equal(retireDefinition.status, 201, JSON.stringify(retireDefinition.body));
  const retireDefinitionId = retireDefinition.body['workflowDefinitionId'] as string;
  for (const [status, version] of [['review', 1], ['active', 2]] as const) {
    const transition = await apiCall(
      port(),
      `/api/workflows/${workflowAId}/definitions/${retireDefinitionId}/status`,
      { token: ownerAToken, method: 'PATCH', body: { status, version } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
  }

  const created = await createDeployment(ownerAToken, workspaceAId, {
    ...selectionV1(),
    playbookVersionId: versionId,
    workflowDefinitionIds: [retireDefinitionId],
    requiredDomainPacks: [],
    requiredCapabilities: [],
    triggerConfig: [{ kind: 'manual' }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const deploymentId = created.body['deploymentId'] as string;

  await apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}/status`, {
    token: ownerAToken,
    method: 'PATCH',
    body: { status: 'retired', version: 3 },
  });

  const validated = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: `validate-retired-${deploymentId}`,
    expectedVersion: 1,
  });
  assert.equal(validated.status, 422, JSON.stringify(validated.body));
  const details = (errorBody(validated)['details'] as string[]) ?? [];
  assert.ok(details.some((detail) => detail.startsWith('playbook-version:')));
  const read = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/${deploymentId}`,
    { token: ownerAToken },
  );
  assert.equal((read.body as Record<string, unknown>)['status'], 'draft');
});

// ---------------------------------------------------------------------------
// DEPLOY-AC-05 — invalid transitions, idempotency, CAS
// ---------------------------------------------------------------------------

test('DEPLOY-AC-05 ROUTE: invalid lifecycle transitions are rejected (frozen machine)', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  const deploymentId = created.body['deploymentId'] as string;

  // draft -> active/paused/blocked/disabled are all illegal (only draft ->
  // validating exists, which is module-internal).
  for (const [action] of [
    ['activate', 'active'],
    ['pause', 'paused'],
    ['block', 'blocked'],
    ['disable', 'disabled'],
  ] as const) {
    const response = await deploymentAction(ownerAToken, workspaceAId, deploymentId, action, {
      idempotencyKey: `invalid-${action}-${deploymentId}`,
      expectedVersion: 1,
      ...(action === 'block' ? { reason: 'attempt' } : {}),
    });
    assert.equal(response.status, 409, `${action} from draft must be a conflict`);
    assert.match(String(errorBody(response)['message']), /illegal deployment transition|requires draft|frozen lifecycle/);
  }

  // ready -> paused/disabled/redeploying/rolling_back are illegal.
  await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: `validate-transitions-${deploymentId}`,
    expectedVersion: 1,
  });
  for (const action of ['pause', 'disable', 'redeploy', 'rollback'] as const) {
    const response = await deploymentAction(ownerAToken, workspaceAId, deploymentId, action, {
      idempotencyKey: `invalid-ready-${action}-${deploymentId}`,
      expectedVersion: 3,
      ...(action === 'redeploy' ? { newSelection: selectionDto(selectionV1()) } : {}),
      ...(action === 'rollback' ? { targetEventId: '11111111-1111-4111-8111-111111111111' } : {}),
    });
    assert.equal(response.status, 409, `${action} from ready must be a conflict`);
  }
});

test('DEPLOY-AC-05 ROUTE: terminal states reject everything (blocked and disabled)', async () => {
  // A ready -> blocked deployment is terminal.
  const blocked = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  const blockedId = blocked.body['deploymentId'] as string;
  await deploymentAction(ownerAToken, workspaceAId, blockedId, 'validate', {
    idempotencyKey: `validate-blocked-${blockedId}`,
    expectedVersion: 1,
  });
  const block = await deploymentAction(ownerAToken, workspaceAId, blockedId, 'block', {
    idempotencyKey: `block-${blockedId}`,
    expectedVersion: 3,
    reason: 'dependency drift observed',
  });
  assert.equal(block.status, 200, JSON.stringify(block.body));
  assert.equal((block.body['deployment'] as Record<string, unknown>)['status'], 'blocked');
  for (const action of ['activate', 'pause', 'disable', 'redeploy', 'rollback'] as const) {
    const response = await deploymentAction(ownerAToken, workspaceAId, blockedId, action, {
      idempotencyKey: `terminal-blocked-${action}-${blockedId}`,
      expectedVersion: 4,
      ...(action === 'redeploy' ? { newSelection: selectionDto(selectionV1()) } : {}),
      ...(action === 'rollback' ? { targetEventId: '11111111-1111-4111-8111-111111111111' } : {}),
    });
    assert.equal(response.status, 409, `${action} from blocked must be a conflict`);
    assert.match(String(errorBody(response)['message']), /terminal/);
  }

  // An active -> disabled deployment is terminal.
  const golden = await goldenDeployment();
  const disable = await deploymentAction(
    ownerAToken,
    workspaceAId,
    golden.deploymentId,
    'disable',
    { idempotencyKey: `disable-${golden.deploymentId}`, expectedVersion: golden.version, reason: 'sunset' },
  );
  assert.equal(disable.status, 200, JSON.stringify(disable.body));
  for (const action of ['activate', 'pause', 'redeploy', 'rollback'] as const) {
    const response = await deploymentAction(
      ownerAToken,
      workspaceAId,
      golden.deploymentId,
      action,
      {
        idempotencyKey: `terminal-disabled-${action}-${golden.deploymentId}`,
        expectedVersion: golden.version + 1,
        ...(action === 'redeploy' ? { newSelection: selectionDto(selectionV1()) } : {}),
        ...(action === 'rollback' ? { targetEventId: '11111111-1111-4111-8111-111111111111' } : {}),
      },
    );
    assert.equal(response.status, 409, `${action} from disabled must be a conflict`);
  }
});

test('DEPLOY-AC-05 ROUTE: material mutations are idempotent (duplicate keys converge, zero new rows)', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  const deploymentId = created.body['deploymentId'] as string;
  const key = `converge-validate-${deploymentId}`;

  const first = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: key,
    expectedVersion: 1,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body['replayed'], false);

  // The duplicate converges: replayed=true, no state change, no version
  // bump, no new ledger row.
  const duplicate = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
    idempotencyKey: key,
    expectedVersion: 999, // a stale CAS token is deliberately NOT re-checked on replay
  });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body['replayed'], true);
  assert.equal((duplicate.body['deployment'] as Record<string, unknown>)['version'], 3);

  const events = await db!.query<{ event_type: string }>(
    `SELECT event_type FROM deployment_events WHERE deployment_id = $1 AND idempotency_key = $2`,
    [deploymentId, key],
  );
  assert.equal(events.rows.length, 1, 'exactly one ledger row for the logical command');

  // A key reused for a DIFFERENT target command is a conflict.
  const reuse = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'activate', {
    idempotencyKey: key,
    expectedVersion: 3,
  });
  assert.equal(reuse.status, 409);
  assert.match(String(errorBody(reuse)['message']), /identifies one logical command/);

  // Stale CAS on a NEW command is a conflict.
  const stale = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'activate', {
    idempotencyKey: `converge-activate-${deploymentId}`,
    expectedVersion: 1,
  });
  assert.equal(stale.status, 409);
  assert.match(String(errorBody(stale)['message']), /does not match expected/);
});

test('DEPLOY-AC-05 ROUTE: concurrent validation attempts — exactly one wins the CAS', async () => {
  const created = await createDeployment(ownerAToken, workspaceAId, selectionV1());
  const deploymentId = created.body['deploymentId'] as string;
  const [first, second] = await Promise.all([
    deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
      idempotencyKey: `race-a-${deploymentId}`,
      expectedVersion: 1,
    }),
    deploymentAction(ownerAToken, workspaceAId, deploymentId, 'validate', {
      idempotencyKey: `race-b-${deploymentId}`,
      expectedVersion: 1,
    }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one validation wins; the loser conflicts');
  const winner = first.status === 200 ? first : second;
  assert.equal((winner.body['deployment'] as Record<string, unknown>)['status'], 'ready');
});

// ---------------------------------------------------------------------------
// DEPLOY-AC-06 — redeploy/rollback change future selection only
// ---------------------------------------------------------------------------

test('DEPLOY-AC-06 ROUTE+DB: redeploy + rollback change FUTURE selection; history stays immutable', async () => {
  const golden = await goldenDeployment();
  const deploymentId = golden.deploymentId;

  // Historical records: an execution requested through the deployment
  // (the request surface), an evidence observation and a learning.
  const execution = await deploymentAction(
    ownerAToken,
    workspaceAId,
    deploymentId,
    'request-execution',
    { triggerIndex: 0, idempotencyKey: `exec-${deploymentId}` },
  );
  assert.equal(execution.status, 201, JSON.stringify(execution.body));
  const executionId = (execution.body['execution'] as Record<string, unknown>)['executionId'] as string;
  assert.ok(typeof executionId === 'string' && executionId.length > 0);
  assert.equal((execution.body['execution'] as Record<string, unknown>)['runtimeClass'], 'pooled-worker');

  const evidence = await apiCall(port(), `/api/clients/${clientAId}/evidence`, {
    token: ownerAToken,
    body: {
      class: 'source_fact',
      sourceSystem: 'mkt040-fixture',
      sourceRef: 'mkt040/history-1',
      observedAt: '2026-02-01T09:00:00.000Z',
      content: { metric: 'spend', value: 2.5, currency: 'USD' },
      contentRef: 'mos-objects://evidence/mkt040-fixture/spend.json',
      quality: 'C',
    },
  });
  assert.equal(evidence.status, 201, JSON.stringify(evidence.body));
  const evidenceId = evidence.body['evidenceId'] as string;

  const learning = await apiCall(port(), `/api/clients/${clientAId}/learnings`, {
    token: ownerAToken,
    body: {
      statement: 'MKT-040 history fixture: deployed playbooks retain their outcome references.',
      applicability: { channel: 'deployment' },
      evidenceRefs: [evidenceId],
      experimentRefs: [],
      confidence: 0.5,
    },
  });
  assert.equal(learning.status, 201, JSON.stringify(learning.body));
  const learningId = learning.body['learningId'] as string;

  // Snapshots of the historical rows BEFORE redeploy/rollback.
  const executionBefore = (
    await db!.query(`SELECT * FROM executions WHERE execution_id = $1`, [executionId])
  ).rows[0]!;
  const evidenceBefore = (
    await db!.query(`SELECT * FROM evidence WHERE evidence_id = $1`, [evidenceId])
  ).rows[0]!;
  const learningBefore = (
    await db!.query(`SELECT * FROM learnings WHERE learning_id = $1`, [learningId])
  ).rows[0]!;
  const ledgerBefore = (
    await db!.query(`SELECT * FROM deployment_events WHERE deployment_id = $1 ORDER BY recorded_at, event_id`, [
      deploymentId,
    ])
  ).rows;

  // ---- REDEPLOY: active -> redeploying with the v2 selection (pending).
  const redeploy = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'redeploy', {
    idempotencyKey: `redeploy-${deploymentId}`,
    expectedVersion: golden.version,
    newSelection: selectionDto(selectionV2()),
  });
  assert.equal(redeploy.status, 200, JSON.stringify(redeploy.body));
  const afterRequest = redeploy.body['deployment'] as Record<string, unknown>;
  assert.equal(afterRequest['status'], 'redeploying');
  // The pending selection rides the ledger; the ROW still pins v1.
  assert.equal(afterRequest['playbookVersionId'], playbookVersionV1Id);
  const requestedEvent = redeploy.body['event'] as Record<string, unknown>;
  assert.equal(requestedEvent['eventType'], 'redeploy-requested');
  assert.equal(
    (requestedEvent['selection'] as Record<string, unknown>)['playbookVersionId'],
    playbookVersionV2Id,
  );

  // ---- The completion edge applies the pending selection.
  const complete = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'activate', {
    idempotencyKey: `redeploy-complete-${deploymentId}`,
    expectedVersion: golden.version + 1,
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  const afterRedeploy = complete.body['deployment'] as Record<string, unknown>;
  assert.equal(afterRedeploy['status'], 'active');
  assert.equal(afterRedeploy['playbookVersionId'], playbookVersionV2Id);
  assert.deepEqual(afterRedeploy['workflowDefinitionIds'], [workflowADefV2Id]);
  assert.deepEqual(afterRedeploy['runtimeRequirements'], { runtimeClass: 'ephemeral-sandbox' });
  const appliedEvent = complete.body['event'] as Record<string, unknown>;
  assert.equal(appliedEvent['eventType'], 'redeploy-applied');
  assert.equal(appliedEvent['fromStatus'], 'redeploying');

  // ---- ROLLBACK to the 'activated' revision (the v1 selection).
  const eventsList = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/${deploymentId}/events`,
    { token: ownerAToken },
  );
  const activatedEvent = (eventsList.body['events'] as Record<string, unknown>[]).find(
    (event) => event['eventType'] === 'activated',
  )!;
  assert.ok(activatedEvent, 'the activated revision exists');
  const rollback = await deploymentAction(ownerAToken, workspaceAId, deploymentId, 'rollback', {
    idempotencyKey: `rollback-${deploymentId}`,
    expectedVersion: afterRedeploy['version'] as number,
    targetEventId: activatedEvent['eventId'] as string,
  });
  assert.equal(rollback.status, 200, JSON.stringify(rollback.body));
  assert.equal((rollback.body['deployment'] as Record<string, unknown>)['status'], 'rolling_back');
  assert.equal(
    ((rollback.body['event'] as Record<string, unknown>)['selection'] as Record<string, unknown>)['playbookVersionId'],
    playbookVersionV1Id,
  );

  const rollbackComplete = await deploymentAction(
    ownerAToken,
    workspaceAId,
    deploymentId,
    'activate',
    {
      idempotencyKey: `rollback-complete-${deploymentId}`,
      expectedVersion: (rollback.body['deployment'] as Record<string, unknown>)['version'] as number,
    },
  );
  assert.equal(rollbackComplete.status, 200, JSON.stringify(rollbackComplete.body));
  const afterRollback = rollbackComplete.body['deployment'] as Record<string, unknown>;
  assert.equal(afterRollback['status'], 'active');
  assert.equal(afterRollback['playbookVersionId'], playbookVersionV1Id);
  assert.deepEqual(afterRollback['runtimeRequirements'], { runtimeClass: 'pooled-worker' });
  assert.equal((rollbackComplete.body['event'] as Record<string, unknown>)['eventType'], 'rollback-applied');

  // ---- HISTORY IMMUTABILITY: the historical rows are byte-identical.
  const executionAfter = (
    await db!.query(`SELECT * FROM executions WHERE execution_id = $1`, [executionId])
  ).rows[0]!;
  assert.deepEqual(executionAfter, executionBefore);
  const evidenceAfter = (
    await db!.query(`SELECT * FROM evidence WHERE evidence_id = $1`, [evidenceId])
  ).rows[0]!;
  assert.deepEqual(evidenceAfter, evidenceBefore);
  const learningAfter = (
    await db!.query(`SELECT * FROM learnings WHERE learning_id = $1`, [learningId])
  ).rows[0]!;
  assert.deepEqual(learningAfter, learningBefore);
  // The pre-redeploy ledger rows are unchanged (the ledger only grew).
  const ledgerAfter = (
    await db!.query(`SELECT * FROM deployment_events WHERE deployment_id = $1 ORDER BY recorded_at, event_id`, [
      deploymentId,
    ])
  ).rows;
  assert.ok(ledgerAfter.length > ledgerBefore.length, 'the ledger grew append-only');
  for (let index = 0; index < ledgerBefore.length; index += 1) {
    assert.deepEqual(ledgerAfter[index], ledgerBefore[index], `ledger row ${index} is unchanged`);
  }

  // ---- DB BACKSTOPS: the database itself rejects history rewrites.
  await assert.rejects(
    () =>
      db!.query(`UPDATE deployment_events SET reason = 'forged' WHERE deployment_id = $1`, [
        deploymentId,
      ]),
    /append-only/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM deployment_events WHERE deployment_id = $1`, [deploymentId]),
    /append-only/,
  );
  // Selection columns are immutable outside the completion edges.
  await assert.rejects(
    () =>
      db!.query(`UPDATE deployments SET playbook_version_id = $1 WHERE deployment_id = $2`, [
        playbookVersionV2Id,
        deploymentId,
      ]),
    /version selection is immutable/,
  );
});

// ---------------------------------------------------------------------------
// DEPLOY-AC-08 — client isolation (uniform 404s on cross-tenant probes)
// ---------------------------------------------------------------------------

test('DEPLOY-AC-08 ROUTE: a foreign deployment is the SAME uniform 404 as an unknown id', async () => {
  const foreign = await goldenDeployment();

  // Under the other agency's workspace path: uniform 404.
  const underForeignPath = await apiCall(
    port(),
    `/api/workspaces/${workspaceBId}/deployments/${foreign.deploymentId}`,
    { token: ownerBToken },
  );
  assert.equal(underForeignPath.status, 404);

  // An unknown id under the same path: the same 404.
  const unknown = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/99999999-9999-4999-8999-999999999999`,
    { token: ownerAToken },
  );
  assert.equal(unknown.status, 404);
  // Uniform posture: identical code and message PATTERN (the ids differ
  // by design — a foreign identifier is not an oracle).
  assert.equal(
    (underForeignPath.body['error'] as Record<string, unknown>)['code'],
    (unknown.body['error'] as Record<string, unknown>)['code'],
  );
  assert.match(
    String((underForeignPath.body['error'] as Record<string, unknown>)['message']),
    /^deployment not found:/,
  );

  // Mutations on the foreign deployment under the foreign path: 404 too.
  const blocked = await deploymentAction(ownerBToken, workspaceBId, foreign.deploymentId, 'pause', {
    idempotencyKey: `foreign-pause-${foreign.deploymentId}`,
    expectedVersion: foreign.version,
  });
  assert.equal(blocked.status, 404);
  const read = await apiCall(
    port(),
    `/api/workspaces/${workspaceAId}/deployments/${foreign.deploymentId}`,
    { token: ownerAToken },
  );
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['status'], 'active');
});

test('DEPLOY-AC-08 ROUTE: cross-client binding attempts are rejected before any write', async () => {
  // A playbook version owned by agency B's client cannot be pinned by a
  // deployment in agency A's workspace (uniform 404, no oracle).
  const playbookB = await apiCall(port(), `/api/clients/${clientBId}/playbooks`, {
    token: ownerBToken,
    body: { name: 'MKT-040 Foreign Playbook', description: 'cross-tenant probe' },
  });
  const playbookBId = playbookB.body['playbookId'] as string;
  const versionB = await apiCall(port(), `/api/playbooks/${playbookBId}/versions`, {
    token: ownerBToken,
    body: {
      strategy: { summary: 'foreign', templates: [{ name: 'T', description: 't' }] },
      deploymentMetadata: {
        requiredDomainPacks: [],
        requiredCapabilities: [],
        runtimeRequirements: { runtimeClass: 'pooled-worker' },
        triggers: [{ kind: 'manual' }],
      },
    },
  });
  const versionBId = versionB.body['versionId'] as string;
  for (const [status, version] of [['review', 1], ['published', 2]] as const) {
    const transition = await apiCall(
      port(),
      `/api/playbooks/${playbookBId}/versions/${versionBId}/status`,
      { token: ownerBToken, method: 'PATCH', body: { status, version } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
  }

  const foreignPlaybook = await createDeployment(ownerAToken, workspaceAId, {
    ...selectionV1(),
    playbookVersionId: versionBId,
    requiredDomainPacks: [],
    requiredCapabilities: [],
    triggerConfig: [{ kind: 'manual' }],
  });
  assert.equal(foreignPlaybook.status, 404);
  assert.equal(errorBody(foreignPlaybook)['code'], 'NOT_FOUND');

  // A workflow definition of the OTHER workspace cannot be pinned.
  const workflowB = await apiCall(port(), `/api/workspaces/${workspaceBId}/workflows`, {
    token: ownerBToken,
    body: { name: 'MKT-040 Foreign Workflow', description: 'cross-tenant probe' },
  });
  const workflowBId = workflowB.body['workflowId'] as string;
  const definitionB = await apiCall(port(), `/api/workflows/${workflowBId}/definitions`, {
    token: ownerBToken,
    body: minimalWorkflowContent(),
  });
  const definitionBId = definitionB.body['workflowDefinitionId'] as string;

  const foreignWorkflow = await createDeployment(ownerAToken, workspaceAId, {
    ...selectionV1(),
    workflowDefinitionIds: [definitionBId],
    requiredDomainPacks: [],
    requiredCapabilities: [],
    triggerConfig: [{ kind: 'manual' }],
  });
  assert.equal(foreignWorkflow.status, 404);
  assert.match(
    String(errorBody(foreignWorkflow)['message']),
    /^workflow definition not found:/,
  );

  // The DB playbook-scope fence: a direct cross-tenant pin is rejected.
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO deployments (deployment_id, agency_id, client_id, workspace_id,
                                  playbook_version_id, workflow_definition_ids, required_domain_packs,
                                  required_capabilities, runtime_requirements, trigger_config)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, '[]'::jsonb, '[]'::jsonb,
                 '{"runtimeClass":"pooled-worker"}'::jsonb, '[{"kind":"manual"}]'::jsonb)`,
        [agencyAId, clientAId, workspaceAId, versionBId, JSON.stringify([workflowADefV1Id])],
      ),
    /cross-tenant deployment binding is rejected/,
  );

  // Nothing was written: the workspace listing still holds only the
  // deployments created by this test file's own tokens.
  const list = await apiCall(port(), `/api/workspaces/${workspaceAId}/deployments`, {
    token: ownerAToken,
  });
  assert.equal(list.status, 200);
  const ids = (list.body['deployments'] as Record<string, unknown>[]).map((d) => d['playbookVersionId']);
  assert.ok(!ids.includes(versionBId), 'the foreign playbook was never persisted');
});

// ---------------------------------------------------------------------------
// DEPLOY-AC-09 — runtime neutrality
// ---------------------------------------------------------------------------

test('DEPLOY-AC-09 ROUTE+DB: all four runtime classes are declarable, persistable and ride execution requests', async () => {
  const classes = [
    'pooled-worker',
    'ephemeral-sandbox',
    'persistent-sandbox',
    'dedicated-runtime',
  ] as const;
  const deploymentIds: string[] = [];
  for (const runtimeClass of classes) {
    const golden = await goldenDeployment(runtimeClass);
    deploymentIds.push(golden.deploymentId);
    const read = await apiCall(
      port(),
      `/api/workspaces/${workspaceAId}/deployments/${golden.deploymentId}`,
      { token: ownerAToken },
    );
    assert.deepEqual((read.body as Record<string, unknown>)['runtimeRequirements'], {
      runtimeClass,
    });
  }

  // Each active deployment can REQUEST an execution carrying its declared
  // class — runtime allocation stays with the Execution/Runtime authority.
  for (let index = 0; index < deploymentIds.length; index += 1) {
    const request = await deploymentAction(
      ownerAToken,
      workspaceAId,
      deploymentIds[index]!,
      'request-execution',
      { triggerIndex: 0, idempotencyKey: `runtime-request-${deploymentIds[index]}` },
    );
    assert.equal(request.status, 201, JSON.stringify(request.body));
    const execution = request.body['execution'] as Record<string, unknown>;
    assert.equal(execution['runtimeClass'], classes[index]);
    // The execution identity exists at the /executions authority with the
    // external-request link referencing this deployment.
    const rows = await db!.query<{ external_request_ref: string | null }>(
      `SELECT external_request_ref FROM executions WHERE execution_id = $1`,
      [execution['executionId'] as string],
    );
    assert.equal(rows.rows.length, 1);
    assert.ok(rows.rows[0]!.external_request_ref !== null);
    assert.match(rows.rows[0]!.external_request_ref!, /deployment:/);
  }

  // The replay converges (idempotent request).
  const replay = await deploymentAction(
    ownerAToken,
    workspaceAId,
    deploymentIds[0]!,
    'request-execution',
    { triggerIndex: 0, idempotencyKey: `runtime-request-${deploymentIds[0]}` },
  );
  assert.equal(replay.status, 200);
  assert.equal((replay.body['execution'] as Record<string, unknown>)['replayed'], true);

  // No infrastructure identity column exists anywhere in the schema.
  const columns = await db!.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name IN ('deployments', 'deployment_events')`,
  );
  const infraPattern = /^(host|hostname|port|region|zone|vm|vmid|instance|instanceid|provider|vendor|cloud|cluster|node|nodeid|machine|machineid|endpoint|url|address|image|container|worker|workerid|runtimeid)$/;
  for (const column of columns.rows) {
    assert.ok(
      !infraPattern.test(column.column_name),
      `infrastructure-identity column '${column.column_name}' must not exist`,
    );
  }

  // The DB CHECK rejects infra-shaped runtime requirements outright.
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO deployments (deployment_id, agency_id, client_id, workspace_id,
                                  playbook_version_id, workflow_definition_ids, required_domain_packs,
                                  required_capabilities, runtime_requirements, trigger_config)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, '[]'::jsonb, '[]'::jsonb,
                 '{"runtimeClass":"pooled-worker","region":"eu-west-1"}'::jsonb, '[{"kind":"manual"}]'::jsonb)`,
        [agencyAId, clientAId, workspaceAId, playbookVersionV1Id, JSON.stringify([workflowADefV1Id])],
      ),
    /check constraint|runtime_requirements/i,
  );
});

// ---------------------------------------------------------------------------
// The pause/resume control loop (the operator experience)
// ---------------------------------------------------------------------------

test('DEPLOY-002 ROUTE: pause and resume round-trip with the full gate on every entry into ACTIVE', async () => {
  const golden = await goldenDeployment();
  const pause = await deploymentAction(ownerAToken, workspaceAId, golden.deploymentId, 'pause', {
    idempotencyKey: `pause-${golden.deploymentId}`,
    expectedVersion: golden.version,
  });
  assert.equal(pause.status, 200, JSON.stringify(pause.body));
  assert.equal((pause.body['deployment'] as Record<string, unknown>)['status'], 'paused');
  assert.equal((pause.body['event'] as Record<string, unknown>)['eventType'], 'paused');

  // Execution requests from a paused deployment are refused (no runtime
  // traffic through a paused control plane).
  const request = await deploymentAction(
    ownerAToken,
    workspaceAId,
    golden.deploymentId,
    'request-execution',
    { triggerIndex: 0, idempotencyKey: `paused-exec-${golden.deploymentId}` },
  );
  assert.equal(request.status, 409);

  // Resume re-runs the full gate (a dependency drift discovered while
  // paused blocks the resume — proven by the suspend connection).
  await db!.query(`UPDATE integration_connections SET status = 'suspended' WHERE connection_id = $1`, [
    connectionAId,
  ]);
  const driftResume = await deploymentAction(
    ownerAToken,
    workspaceAId,
    golden.deploymentId,
    'resume',
    { idempotencyKey: `resume-drift-${golden.deploymentId}`, expectedVersion: golden.version + 1 },
  );
  assert.equal(driftResume.status, 422);
  await db!.query(`UPDATE integration_connections SET status = 'connected' WHERE connection_id = $1`, [
    connectionAId,
  ]);

  const resume = await deploymentAction(ownerAToken, workspaceAId, golden.deploymentId, 'resume', {
    idempotencyKey: `resume-${golden.deploymentId}`,
    expectedVersion: golden.version + 1,
  });
  assert.equal(resume.status, 200, JSON.stringify(resume.body));
  assert.equal((resume.body['deployment'] as Record<string, unknown>)['status'], 'active');
  assert.equal((resume.body['event'] as Record<string, unknown>)['eventType'], 'resumed');
  assert.ok((resume.body['event'] as Record<string, unknown>)['validationReport'] !== null);
});

test('DEPLOY-002 ROUTE: the workspace listing + member read posture', async () => {
  const list = await apiCall(port(), `/api/workspaces/${workspaceAId}/deployments`, {
    token: ownerAToken,
  });
  assert.equal(list.status, 200);
  assert.ok((list.body['deployments'] as unknown[]).length >= 4);
  // A foreign principal listing another workspace's deployments: 404.
  const foreignList = await apiCall(port(), `/api/workspaces/${workspaceAId}/deployments`, {
    token: ownerBToken,
  });
  assert.equal(foreignList.status, 404);
});
