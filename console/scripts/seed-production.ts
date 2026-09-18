/**
 * DEP-002 — demo seed for the MOS staging runtime.
 *
 * EVERY datum is created THROUGH THE REAL HTTP API of the running MOS
 * instance (http://127.0.0.1:3010) — never direct SQL, never invented
 * endpoints. The only out-of-band piece is the platform admin, which is
 * bootstrapped by MOS's own env contract (MOS_BOOTSTRAP_PLATFORM_ADMIN_*).
 *
 * Idempotency: check-then-create by stable names/emails/objectives/source
 * refs; commands with §8 idempotency keys use stable keys and accept the
 * 200 replay. Re-running makes no changes.
 *
 * Demo story: the agency "Northwind Growth Partners" runs growth for two
 * B2B clients — Helio Robotics (full chain: goal → playbook → workflow →
 * deployment → running instance → REAL worker-executed run → decisions →
 * learnings → metrics) and Atlas Freight Systems (goal + metrics). The
 * four MKT-051 first-party packs are published, MOS_CERTIFIED and
 * installed in Helio's workspace.
 */

/**
 * DEP-005 — production seed for the DEPLOYED MOS product (Vercel).
 *
 * Adapted from the proven DEP-002 staging seed (mini-services/mos-api-service/
 * seed.ts — same demo data, same idempotency, same real-API-only posture) to
 * run against the DEPLOYED production URL through the same-origin bridge:
 * every MOS path "/api/x" is rewritten to "${BASE}/api/mos/x". The platform
 * admin comes from the deployed env's MOS_BOOTSTRAP_PLATFORM_ADMIN_* and the
 * service principal from its MOS_INTERNAL_API_TOKEN (passed via env — never
 * hardcoded). Because production has no continuous worker (Vercel Hobby),
 * waitForTerminal kicks the admin-gated drain route while waiting for the
 * queued execution to settle.
 *
 * DEP-007 — production demo data brought to FULL PARITY with staging: step 19b
 * (Sam's live OPEN human-work offer, DEP-006 D5 + DEP-006b hardening) is
 * ported from the staging seed, plus the three DEP-006 re-run idempotency
 * fixes (eligibility availability window, /api/apps manifest.version
 * published-check, clientB metric refs) so the production seed is safely
 * re-runnable in every end state, exactly like staging.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// P0-SRC: import adapted to the repository layout — the manifests now come
// from THIS repository's own frozen v1.5 backend (../../src relative to
// console/scripts/), not the external source workspace the seed originally
// ran against.
import { allFirstPartyManifests } from '../../src/modules/first-party-apps/public.ts';

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env['MOS_SEED_BASE_URL'] ?? '').replace(/\/$/, '');
if (BASE === '') {
  process.stderr.write('[seed] MOS_SEED_BASE_URL is required (the deployed production URL)\n');
  process.exit(2);
}

const ADMIN_EMAIL = process.env['MOS_SEED_ADMIN_EMAIL'] ?? 'admin@mos.demo';
const ADMIN_PASSWORD = process.env['MOS_SEED_ADMIN_PASSWORD'] ?? '';
/** Must equal MOS_INTERNAL_API_TOKEN of the deployed api (svc principal). */
const INTERNAL_API_TOKEN = process.env['MOS_INTERNAL_API_TOKEN'] ?? '';

const AGENCY_NAME = 'Northwind Growth Partners';

const USERS = {
  owner: { email: 'casey@northwind.demo', password: 'Northwind-Owner-2026', displayName: 'Casey Okafor' },
  ops: { email: 'jordan@northwind.demo', password: 'Northwind-Ops-2026', displayName: 'Jordan Meyer' },
  agent: { email: 'sam@northwind.demo', password: 'Northwind-Agent-2026', displayName: 'Sam Adeyemi' },
} as const;

const CLIENT_A_NAME = 'Helio Robotics';
const CLIENT_B_NAME = 'Atlas Freight Systems';
const WORKSPACE_NAME = 'Helio Growth Workspace';

const GOAL_A_OBJECTIVE = 'Grow monthly recurring revenue from Helio Robotics inspection subscriptions to $5,000';
const GOAL_B_OBJECTIVE = 'Bring Atlas Freight Systems customer-acquisition payback under nine months';
const PLAYBOOK_NAME = 'Helio Q4 Demand Playbook';
const WORKFLOW_NAME = 'Helio Inspection Demand Workflow';

const APP_KEYS = ['mos-analytics', 'mos-crm', 'mos-sheets', 'mos-portal'] as const;
const INSTALL_VERSION = '1.1.0';

// ---------------------------------------------------------------------------
// tiny HTTP client + logging
// ---------------------------------------------------------------------------

interface ApiResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function api(pathName: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // DEP-005: every MOS path is served through the deployed same-origin
  // bridge — "/api/<x>" → "${BASE}/api/mos/<x>" (pure transport rewrite).
  const bridgePathName = pathName.startsWith('/api/')
    ? `/api/mos/${pathName.slice('/api/'.length)}`
    : pathName;
  const response = await fetch(`${BASE}${bridgePathName}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

const changes: string[] = [];
const reuses: string[] = [];
const ids: Record<string, string> = {};

function created(what: string, detail: string): void {
  changes.push(`${what}: ${detail}`);
  process.stdout.write(`[seed] CREATED ${what}: ${detail}\n`);
}
function reused(what: string, detail: string): void {
  reuses.push(`${what}: ${detail}`);
  process.stdout.write(`[seed] exists  ${what}: ${detail}\n`);
}
function info(what: string): void {
  process.stdout.write(`[seed] ${what}\n`);
}

function expectOk(result: ApiResult, what: string, allowed: readonly number[] = [200, 201]): ApiResult {
  if (!allowed.includes(result.status)) {
    throw new Error(`${what} failed: HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 500)}`);
  }
  return result;
}

function rowsOf(result: ApiResult, key: string): Record<string, unknown>[] {
  const rows = result.body[key];
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function login(email: string, password: string): Promise<string> {
  const result = await api('/api/auth/login', { body: { email, password } });
  expectOk(result, `login ${email}`);
  return result.body['token'] as string;
}

// ---------------------------------------------------------------------------
// manifest signing (the offline App-SDK step, mirrored exactly: sha256 over
// canonical JSON with keys sorted at every level + '|mkt-047-app-manifest')
// ---------------------------------------------------------------------------

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

function canonicalize(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JSONValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]!);
    }
    return sorted;
  }
  return value;
}

function signManifest(manifest: unknown): { algorithm: string; digest: string } {
  return {
    algorithm: 'manifest-sha256-fingerprint',
    digest: createHash('sha256')
      .update(JSON.stringify(canonicalize(manifest as JSONValue)))
      .update('|mkt-047-app-manifest')
      .digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// workflow graph fixtures (the proven integration-test shapes)
// ---------------------------------------------------------------------------

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

function humanTaskNode(nodeId: string): Record<string, unknown> {
  return {
    ...functionNode(nodeId),
    nodeType: 'human_task',
    outputSchema: { type: 'object', properties: { out: { type: 'string', description: null } }, required: [] },
    humanApproval: { required: true, approverPolicyRef: null },
  };
}

function terminalNode(nodeId: string): Record<string, unknown> {
  return { ...functionNode(nodeId), nodeType: 'terminal' };
}

function successEdge(fromNode: string, toNode: string): Record<string, unknown> {
  return { fromNode, toNode, edgeType: 'success', predicateRef: null, joinSemantics: null };
}

// ===========================================================================
// SEED
// ===========================================================================

async function main(): Promise<void> {
  info(`seeding against ${BASE} (every datum through the real API)`);

  // --- 0. health ----------------------------------------------------------
  const health = await api('/api/platform/health');
  expectOk(health, 'platform health');
  info(`health: ${JSON.stringify(health.body)}`);

  // --- 1. admin session ---------------------------------------------------
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  info('platform admin session established (bootstrap credential)');

  // --- 2. platform policies (fail-closed dimensions need explicit allows) --
  const policies = rowsOf(await api('/api/policies', { token: admin }), 'policies');
  for (const dimension of ['deployment', 'extension']) {
    const active = policies.some((row) => row['dimension'] === dimension && row['status'] === 'active');
    if (active) {
      reused('platform policy', dimension);
    } else {
      const declared = await api('/api/policies', {
        token: admin,
        body: {
          dimension,
          rules: [{ effect: 'allow', operations: ['*'], reason: 'DEP-002 staging default: explicit allow' }],
          description: `DEP-002 staging platform default (${dimension})`,
        },
      });
      expectOk(declared, `declare platform policy ${dimension}`, [201]);
      created('platform policy', `${dimension} (policyId ${String(declared.body['policyId'])})`);
    }
  }

  // --- 3. users (login-probe check-then-create) ---------------------------
  const sessions: Record<string, string> = {};
  for (const [key, user] of Object.entries(USERS)) {
    const probe = await api('/api/auth/login', { body: { email: user.email, password: user.password } });
    if (probe.status === 200) {
      sessions[key] = probe.body['token'] as string;
      ids[`user.${key}`] = probe.body['userId'] as string;
      reused('user', `${user.email} (userId ${ids[`user.${key}`]})`);
      continue;
    }
    const createUser = await api('/api/users', {
      token: admin,
      body: { email: user.email, displayName: user.displayName },
    });
    expectOk(createUser, `create user ${user.email}`, [201]);
    const userId = createUser.body['userId'] as string;
    const credential = await api(`/api/users/${userId}/credential`, { token: admin, body: { password: user.password } });
    expectOk(credential, `credential ${user.email}`, [204, 200]);
    sessions[key] = await login(user.email, user.password);
    ids[`user.${key}`] = userId;
    created('user', `${user.email} (userId ${userId})`);
  }
  const owner = sessions['owner']!;

  // --- 4. agency (via the owner's authorization context) -------------------
  const context = expectOk(await api('/api/auth/authorization-context', { token: owner }), 'authorization-context');
  const memberships = (context.body['memberships'] as Record<string, unknown>[]) ?? [];
  let agencyId: string | null = null;
  for (const membership of memberships) {
    const candidate = membership['agencyId'] as string;
    const agencyRead = await api(`/api/agencies/${candidate}`, { token: admin });
    if (agencyRead.status === 200) {
      const record = (agencyRead.body['agency'] as Record<string, unknown> | undefined) ?? agencyRead.body;
      if ((record['name'] as string | undefined) === AGENCY_NAME) {
        agencyId = candidate;
        break;
      }
    }
  }
  if (agencyId !== null) {
    reused('agency', `${AGENCY_NAME} (${agencyId})`);
  } else {
    const created_ = await api('/api/agencies', {
      token: admin,
      body: { name: AGENCY_NAME, ownerUserId: ids['user.owner'] },
    });
    expectOk(created_, 'create agency', [201]);
    agencyId = (created_.body['agency'] as Record<string, unknown>)['agencyId'] as string;
    created('agency', `${AGENCY_NAME} (${agencyId}, owner ${USERS.owner.email})`);
  }
  ids['agency'] = agencyId;

  // --- 5. memberships (ops + human agent) ----------------------------------
  const membershipList = rowsOf(await api(`/api/agencies/${agencyId}/memberships`, { token: owner }), 'memberships');
  const memberUserIds = new Set(membershipList.map((row) => row['userId'] as string));
  for (const [key, role] of [
    ['ops', 'agency_operator'],
    ['agent', 'human_agent'],
  ] as const) {
    if (memberUserIds.has(ids[`user.${key}`]!)) {
      reused('membership', `${USERS[key].email} (${role})`);
    } else {
      const added = await api(`/api/agencies/${agencyId}/memberships`, {
        token: admin,
        body: { userId: ids[`user.${key}`], role },
      });
      expectOk(added, `membership ${USERS[key].email}`, [201]);
      created('membership', `${USERS[key].email} (${role})`);
    }
  }

  // --- 6. clients ----------------------------------------------------------
  const clients = rowsOf(await api(`/api/agencies/${agencyId}/clients`, { token: owner }), 'clients');
  const liveClients = clients.filter((row) => row['status'] === 'active' || row['status'] === 'live' || row['status'] === undefined);
  async function ensureClient(name: string): Promise<string> {
    const found = liveClients.find((row) => row['name'] === name);
    if (found !== undefined) {
      reused('client', `${name} (${String(found['clientId'])})`);
      return found['clientId'] as string;
    }
    const result = await api(`/api/agencies/${agencyId}/clients`, { token: admin, body: { name } });
    expectOk(result, `create client ${name}`, [201]);
    created('client', `${name} (${String(result.body['clientId'])})`);
    return result.body['clientId'] as string;
  }
  ids['clientA'] = await ensureClient(CLIENT_A_NAME);
  ids['clientB'] = await ensureClient(CLIENT_B_NAME);

  // --- 7. workspace ---------------------------------------------------------
  const workspaces = rowsOf(await api(`/api/clients/${ids['clientA']}/workspaces`, { token: owner }), 'workspaces');
  const existingWorkspace = workspaces.find((row) => row['name'] === WORKSPACE_NAME);
  if (existingWorkspace !== undefined) {
    ids['workspace'] = existingWorkspace['workspaceId'] as string;
    reused('workspace', `${WORKSPACE_NAME} (${ids['workspace']})`);
  } else {
    const result = await api(`/api/clients/${ids['clientA']}/workspaces`, { token: owner, body: { name: WORKSPACE_NAME } });
    expectOk(result, 'create workspace', [201]);
    ids['workspace'] = result.body['workspaceId'] as string;
    created('workspace', `${WORKSPACE_NAME} (${ids['workspace']})`);
  }

  // --- 8. goals -------------------------------------------------------------
  async function ensureGoal(
    clientId: string,
    objective: string,
    criteria: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const goals = rowsOf(await api(`/api/clients/${clientId}/goals`, { token: owner }), 'goals');
    const found = goals.find((row) => row['objective'] === objective);
    if (found !== undefined) {
      const goalId = found['goalId'] as string;
      if (found['status'] === 'draft') {
        const activated = await api(`/api/goals/${goalId}/status`, {
          token: owner,
          method: 'PATCH',
          body: { status: 'active', version: found['version'] as number },
        });
        expectOk(activated, `activate goal ${objective}`, [200]);
        created('goal activation', `${objective} (${goalId})`);
      } else {
        reused('goal', `${objective} (${goalId}, ${String(found['status'])})`);
      }
      return goalId;
    }
    const result = await api(`/api/clients/${clientId}/goals`, {
      token: owner,
      body: { objective, successCriteria: criteria, ...extra },
    });
    expectOk(result, `create goal ${objective}`, [201]);
    const goalId = result.body['goalId'] as string;
    const activated = await api(`/api/goals/${goalId}/status`, {
      token: owner,
      method: 'PATCH',
      body: { status: 'active', version: result.body['version'] as number },
    });
    expectOk(activated, `activate goal ${objective}`, [200]);
    created('goal', `${objective} (${goalId}, active)`);
    return goalId;
  }
  ids['goalA'] = await ensureGoal(
    ids['clientA'],
    GOAL_A_OBJECTIVE,
    [
      { metric: 'revenue', comparator: '>=', targetValue: 5000, unit: 'USD', description: 'Monthly recurring revenue' },
      { metric: 'pipeline_accounts', comparator: '>=', targetValue: 12, unit: 'accounts', description: 'Qualified accounts in pipeline' },
    ],
    {
      workspaceId: ids['workspace'],
      metrics: [
        { name: 'revenue', unit: 'USD', description: 'MRR from inspection subscriptions' },
        { name: 'pipeline_accounts', unit: 'accounts', description: 'Qualified pipeline accounts' },
      ],
      constraints: [{ kind: 'resource', description: 'Media spend capped at $2,500/month' }],
      timeHorizon: { startsOn: '2026-09-01', endsOn: '2026-12-31' },
    },
  );
  ids['goalB'] = await ensureGoal(
    ids['clientB'],
    GOAL_B_OBJECTIVE,
    [{ metric: 'cac', comparator: '<=', targetValue: 900, unit: 'USD', description: 'Blended CAC at or under $900' }],
    {
      metrics: [{ name: 'cac', unit: 'USD', description: 'Blended customer acquisition cost' }],
      constraints: [],
      timeHorizon: { startsOn: '2026-09-01', endsOn: '2026-11-30' },
    },
  );

  // --- 9. playbook + published version --------------------------------------
  const playbooks = rowsOf(await api(`/api/clients/${ids['clientA']}/playbooks`, { token: owner }), 'playbooks');
  const existingPlaybook = playbooks.find((row) => row['name'] === PLAYBOOK_NAME);
  let playbookId: string;
  if (existingPlaybook !== undefined) {
    playbookId = existingPlaybook['playbookId'] as string;
    reused('playbook', `${PLAYBOOK_NAME} (${playbookId})`);
  } else {
    const result = await api(`/api/clients/${ids['clientA']}/playbooks`, {
      token: owner,
      body: { name: PLAYBOOK_NAME, description: 'Industrial-search-led demand generation for the autonomous inspection line.', goalId: ids['goalA'] },
    });
    expectOk(result, 'create playbook', [201]);
    playbookId = result.body['playbookId'] as string;
    created('playbook', `${PLAYBOOK_NAME} (${playbookId})`);
  }
  ids['playbook'] = playbookId;

  const playbookVersions = rowsOf(await api(`/api/playbooks/${playbookId}/versions`, { token: owner }), 'versions');
  let playbookVersionId: string | undefined = playbookVersions.find((row) => row['status'] === 'published')?.['versionId'] as string | undefined;
  if (playbookVersionId !== undefined) {
    reused('playbook version', `published version ${playbookVersionId}`);
  } else {
    const draft = await api(`/api/playbooks/${playbookId}/versions`, {
      token: owner,
      body: {
        strategy: {
          summary: 'Win industrial inspection buyers with programmatic search clusters, then convert through a five-touch onboarding sequence.',
          templates: [
            { name: 'Programmatic SEO', description: 'Topic clusters around hangar inspection compliance' },
            { name: 'Onboarding sequence', description: 'Five-touch activation email chain' },
          ],
        },
        deploymentMetadata: {
          requiredDomainPacks: [],
          requiredCapabilities: [],
          runtimeRequirements: { runtimeClass: 'pooled-worker' },
          triggers: [
            { kind: 'manual' },
            { kind: 'schedule', config: { cron: '0 9 * * 1' } },
          ],
        },
      },
    });
    expectOk(draft, 'create playbook version', [201]);
    playbookVersionId = draft.body['versionId'] as string;
    let version = draft.body['version'] as number;
    for (const status of ['review', 'published'] as const) {
      const transition = await api(`/api/playbooks/${playbookId}/versions/${playbookVersionId}/status`, {
        token: owner,
        method: 'PATCH',
        body: { status, version },
      });
      expectOk(transition, `playbook version → ${status}`, [200]);
      version = transition.body['version'] as number;
    }
    created('playbook version', `published ${playbookVersionId}`);
  }
  ids['playbookVersion'] = playbookVersionId;

  // --- 10. workflow + active definition -------------------------------------
  const workflows = rowsOf(await api(`/api/workspaces/${ids['workspace']}/workflows`, { token: owner }), 'workflows');
  const existingWorkflow = workflows.find((row) => row['name'] === WORKFLOW_NAME);
  let workflowId: string;
  if (existingWorkflow !== undefined) {
    workflowId = existingWorkflow['workflowId'] as string;
    reused('workflow', `${WORKFLOW_NAME} (${workflowId})`);
  } else {
    const result = await api(`/api/workspaces/${ids['workspace']}/workflows`, {
      token: owner,
      body: { name: WORKFLOW_NAME, description: 'Prep → field visit → done: the delivery workflow for the Q4 demand playbook.' },
    });
    expectOk(result, 'create workflow', [201]);
    workflowId = result.body['workflowId'] as string;
    created('workflow', `${WORKFLOW_NAME} (${workflowId})`);
  }
  ids['workflow'] = workflowId;

  const definitions = rowsOf(await api(`/api/workflows/${workflowId}/definitions`, { token: owner }), 'definitions');
  let definitionId: string | undefined = definitions.find((row) => row['status'] === 'active')?.['workflowDefinitionId'] as string | undefined;
  if (definitionId !== undefined) {
    reused('workflow definition', `active ${definitionId}`);
  } else {
    const draft = await api(`/api/workflows/${workflowId}/definitions`, {
      token: owner,
      body: {
        graph: {
          nodes: [functionNode('prep'), humanTaskNode('visit'), terminalNode('done')],
          edges: [successEdge('prep', 'visit'), successEdge('visit', 'done')],
        },
        inputSchema: { ...emptySchema },
        outputSchema: { ...emptySchema },
        retryPolicyDefaults: {},
        concurrencyLimits: {},
        timeoutPolicy: {},
        compensation: [],
        playbookVersionId,
      },
    });
    expectOk(draft, 'create workflow definition', [201]);
    definitionId = draft.body['workflowDefinitionId'] as string;
    let version = draft.body['version'] as number;
    for (const status of ['review', 'active'] as const) {
      const transition = await api(`/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
        token: owner,
        method: 'PATCH',
        body: { status, version },
      });
      expectOk(transition, `definition → ${status}`, [200]);
      version = transition.body['version'] as number;
    }
    created('workflow definition', `active ${definitionId} (prep → visit → done)`);
  }
  ids['definition'] = definitionId;

  // --- 11. deployment (create → validate → activate) -------------------------
  const deployments = rowsOf(await api(`/api/workspaces/${ids['workspace']}/deployments`, { token: owner }), 'deployments');
  let deployment = deployments.find(
    (row) => row['playbookVersionId'] === playbookVersionId && row['status'] === 'active',
  );
  if (deployment !== undefined) {
    reused('deployment', `active ${String(deployment['deploymentId'])}`);
  } else {
    const createdDeployment = await api(`/api/workspaces/${ids['workspace']}/deployments`, {
      token: owner,
      body: {
        selection: {
          playbookVersionId,
          workflowDefinitionIds: [definitionId],
          requiredDomainPacks: [],
          requiredCapabilities: [],
          runtimeRequirements: { runtimeClass: 'pooled-worker' },
          triggerConfig: [{ kind: 'manual' }],
        },
      },
    });
    expectOk(createdDeployment, 'create deployment', [201]);
    const deploymentId = createdDeployment.body['deploymentId'] as string;
    let version = createdDeployment.body['version'] as number;
    const validated = await api(`/api/workspaces/${ids['workspace']}/deployments/${deploymentId}/validate`, {
      token: owner,
      body: { idempotencyKey: `dep002-validate-${deploymentId}`, expectedVersion: version },
    });
    expectOk(validated, 'validate deployment', [200]);
    version = (validated.body['deployment'] as Record<string, unknown>)['version'] as number;
    const activated = await api(`/api/workspaces/${ids['workspace']}/deployments/${deploymentId}/activate`, {
      token: owner,
      body: { idempotencyKey: `dep002-activate-${deploymentId}`, expectedVersion: version },
    });
    expectOk(activated, 'activate deployment', [200]);
    deployment = (activated.body['deployment'] as Record<string, unknown>);
    created('deployment', `${deploymentId} → active (validated: 9 green checks)`);
  }
  ids['deployment'] = deployment['deploymentId'] as string;

  // --- 12. workflow instances (one RUNNING delivery, one PAUSED for attention)
  const instances = rowsOf(await api(`/api/workflows/${workflowId}/instances`, { token: owner }), 'instances');
  const runningInstance = instances.find((row) => row['status'] === 'running');
  if (runningInstance !== undefined) {
    ids['instance'] = runningInstance['workflowInstanceId'] as string;
    reused('workflow instance', `running ${ids['instance']}`);
  } else {
    const draft = await api(`/api/workflows/${workflowId}/definitions/${definitionId}/instances`, { token: owner, body: {} });
    expectOk(draft, 'create instance', [201]);
    const instanceId = draft.body['workflowInstanceId'] as string;
    let version = draft.body['version'] as number;
    for (const to of ['ready', 'running'] as const) {
      const transition = await api(`/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
        token: owner,
        body: { to, version, idempotencyKey: `dep002-inst1-${to}-${instanceId}` },
      });
      expectOk(transition, `instance → ${to}`, [200]);
      version = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
    }
    ids['instance'] = instanceId;
    created('workflow instance', `running ${instanceId} (the delivered run)`);
  }
  const pausedInstance = instances.find((row) => row['status'] === 'paused');
  if (pausedInstance !== undefined) {
    ids['pausedInstance'] = pausedInstance['workflowInstanceId'] as string;
    reused('workflow instance', `paused ${ids['pausedInstance']} (attention fixture)`);
  } else {
    const draft = await api(`/api/workflows/${workflowId}/definitions/${definitionId}/instances`, { token: owner, body: {} });
    expectOk(draft, 'create instance (pause fixture)', [201]);
    const instanceId = draft.body['workflowInstanceId'] as string;
    let version = draft.body['version'] as number;
    for (const to of ['ready', 'running', 'paused'] as const) {
      const transition = await api(`/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
        token: owner,
        body: { to, version, idempotencyKey: `dep002-inst2-${to}-${instanceId}` },
      });
      expectOk(transition, `pause-fixture instance → ${to}`, [200]);
      version = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
    }
    ids['pausedInstance'] = instanceId;
    created('workflow instance', `paused ${instanceId} (feeds the AI-operator attention queue)`);
  }

  // --- 13. evidence -----------------------------------------------------------
  const evidenceList = rowsOf(await api(`/api/clients/${ids['clientA']}/evidence`, { token: owner }), 'evidence');
  const evidenceByRef = new Map(
    evidenceList
      .map((row) => [(row['source'] as Record<string, unknown> | undefined)?.['ref'] as string | undefined, row['evidenceId'] as string])
      .filter((entry): entry is [string, string] => entry[0] !== undefined),
  );
  async function ensureEvidence(sourceRef: string, body: Record<string, unknown>): Promise<string> {
    const existing = evidenceByRef.get(sourceRef);
    if (existing !== undefined) return existing;
    const result = await api(`/api/clients/${ids['clientA']}/evidence`, { token: owner, body: { sourceSystem: 'meta-ads', quality: 'B', ...body, sourceRef } });
    expectOk(result, `evidence ${sourceRef}`, [201]);
    const evidenceId = result.body['evidenceId'] as string;
    evidenceByRef.set(sourceRef, evidenceId);
    created('evidence', `${sourceRef} (${evidenceId})`);
    return evidenceId;
  }
  ids['evidenceRevenue'] = await ensureEvidence('report/2026-09-revenue', {
    class: 'observation',
    observedAt: '2026-09-15T10:30:00.000Z',
    content: { metric: 'revenue', value: 5000, unit: 'USD' },
  });
  ids['evidenceVisit'] = await ensureEvidence('report/2026-09-job-outcome', {
    class: 'observation',
    observedAt: '2026-09-16T14:00:00.000Z',
    content: { metric: 'visit_outcome', value: 1, unit: 'count' },
  });
  ids['evidenceActivation'] = await ensureEvidence('warehouse/activation-export', {
    class: 'source_fact',
    sourceSystem: 'internal-warehouse',
    observedAt: '2026-09-14T08:00:00.000Z',
    content: { metric: 'activation_rate', value: 0.42, unit: 'ratio' },
    quality: 'C',
  });

  // --- 14. learnings ------------------------------------------------------------
  const learningList = rowsOf(await api(`/api/clients/${ids['clientA']}/learnings`, { token: owner }), 'learnings');
  async function ensureLearning(statement: string, body: Record<string, unknown>): Promise<string> {
    const found = learningList.find((row) => (row['statement'] as string) === statement);
    if (found !== undefined) return found['learningId'] as string;
    const result = await api(`/api/clients/${ids['clientA']}/learnings`, { token: owner, body: { statement, ...body } });
    expectOk(result, `learning ${statement.slice(0, 40)}…`, [201]);
    created('learning', `${statement.slice(0, 60)}… (${String(result.body['learningId'])})`);
    return result.body['learningId'] as string;
  }
  ids['learning1'] = await ensureLearning('The five-touch onboarding sequence lifted new-account activation by 2.1 points against the three-touch baseline.', {
    applicability: { channel: 'email', segment: 'industrial-buyers' },
    evidenceRefs: [ids['evidenceActivation']],
    experimentRefs: [],
    confidence: 0.72,
  });
  ids['learning2'] = await ensureLearning('On-site visits close signed-feedback loops roughly twice as fast as email reminders for industrial clients.', {
    applicability: { channel: 'field', segment: 'industrial-buyers' },
    evidenceRefs: [ids['evidenceVisit']],
    experimentRefs: [],
    confidence: 0.61,
  });

  // --- 15. metrics (the append-only revenue ledger + friends) --------------------
  const metricList = rowsOf(await api(`/api/clients/${ids['clientA']}/metrics`, { token: owner }), 'observations');
  // DEP-006/DEP-007: the cac observation belongs to clientB — include its refs
  // too, or every re-run would append a DUPLICATE observation (append-only ledger).
  const metricListB = rowsOf(await api(`/api/clients/${ids['clientB']}/metrics`, { token: owner }), 'observations');
  const metricRefs = new Set(
    [...metricList, ...metricListB]
      .map((row) => (row['source'] as Record<string, unknown> | undefined)?.['ref'] as string | undefined)
      .filter((ref): ref is string => ref !== undefined),
  );
  async function ensureMetric(clientId: string, body: Record<string, unknown>): Promise<void> {
    const sourceRef = body['sourceRef'] as string;
    if (metricRefs.has(sourceRef)) {
      reused('metric observation', `${String(body['metricName'])} @ ${sourceRef}`);
      return;
    }
    const result = await api(`/api/clients/${clientId}/metrics`, { token: owner, body });
    expectOk(result, `metric ${String(body['metricName'])} @ ${sourceRef}`, [201]);
    metricRefs.add(sourceRef);
    created('metric observation', `${String(body['metricName'])} = ${String(body['value'])} ${String(body['unit'])} @ ${sourceRef} (${String(result.body['observationId'])})`);
  }
  await ensureMetric(ids['clientA'], {
    metricName: 'revenue', dimensions: { series: 'monthly' }, value: 5000, unit: 'USD',
    sourceSystem: 'meta-ads', sourceRef: 'report/2026-09-revenue', observedAt: '2026-09-15T10:30:00.000Z', quality: 'ok',
  });
  await ensureMetric(ids['clientA'], {
    metricName: 'revenue', dimensions: { series: 'monthly' }, value: 5200, unit: 'USD',
    sourceSystem: 'meta-ads', sourceRef: 'report/2026-09-revenue-restated', observedAt: '2026-09-16T10:30:00.000Z',
    quality: 'restated', evidenceRef: ids['evidenceRevenue'],
  });
  await ensureMetric(ids['clientA'], {
    metricName: 'revenue', dimensions: { series: 'euro' }, value: 90, unit: 'EUR',
    sourceSystem: 'meta-ads', sourceRef: 'report/2026-09-euro', observedAt: '2026-09-15T10:30:00.000Z', quality: 'ok',
  });
  await ensureMetric(ids['clientA'], {
    metricName: 'revenue', dimensions: { series: 'monthly' }, value: 300, unit: 'USD',
    sourceSystem: 'meta-ads', sourceRef: 'report/2026-09-ws', observedAt: '2026-09-15T10:30:00.000Z',
    quality: 'ok', workspaceId: ids['workspace'],
  });
  await ensureMetric(ids['clientA'], {
    metricName: 'pipeline_accounts', dimensions: { stage: 'qualified' }, value: 14, unit: 'accounts',
    sourceSystem: 'internal-warehouse', sourceRef: 'warehouse/pipeline-export', observedAt: '2026-09-17T06:00:00.000Z', quality: 'ok',
  });
  await ensureMetric(ids['clientA'], {
    metricName: 'activation_rate', dimensions: {}, value: 0.42, unit: 'ratio',
    sourceSystem: 'internal-warehouse', sourceRef: 'internal/activation', observedAt: '2026-09-14T08:00:00.000Z', quality: 'ok',
  });
  await ensureMetric(ids['clientB'], {
    metricName: 'cac', dimensions: { series: 'monthly' }, value: 1180, unit: 'USD',
    sourceSystem: 'internal-warehouse', sourceRef: 'warehouse/atlas-cac', observedAt: '2026-09-15T08:00:00.000Z', quality: 'ok',
  });

  // --- 16. executions + the REAL worker-executed run -----------------------------
  const executions = rowsOf(await api(`/api/workspaces/${ids['workspace']}/executions`, { token: owner }), 'executions');
  const prepExecution = executions.find(
    (row) => row['workflowInstanceId'] === ids['instance'] && (row['taskLink'] as Record<string, unknown> | undefined)?.['nodeId'] === 'prep',
  ) ?? executions.find((row) => (row['taskLink'] as Record<string, unknown> | undefined)?.['nodeId'] === 'prep');
  if (prepExecution !== undefined) {
    ids['execPrep'] = prepExecution['executionId'] as string;
    reused('execution', `prep ${ids['execPrep']} (${String(prepExecution['status'])})`);
  } else {
    const result = await api(`/api/workspaces/${ids['workspace']}/executions`, {
      token: owner,
      body: {
        workflowInstanceId: ids['instance'],
        nodeId: 'prep',
        executionKind: 'deterministic',
        runtimeClass: 'pooled-worker',
        idempotencyKey: 'dep002-exec-prep-1',
      },
    });
    expectOk(result, 'create prep execution', [201]);
    ids['execPrep'] = (result.body['execution'] as Record<string, unknown>)['executionId'] as string;
    created('execution', `prep ${ids['execPrep']} (deterministic, pooled-worker)`);
  }

  const visitExecution = executions.find((row) => (row['taskLink'] as Record<string, unknown> | undefined)?.['nodeId'] === 'visit');
  if (visitExecution === undefined) {
    const result = await api(`/api/workspaces/${ids['workspace']}/executions`, {
      token: owner,
      body: {
        workflowInstanceId: ids['instance'],
        nodeId: 'visit',
        executionKind: 'human',
        runtimeClass: 'pooled-worker',
        idempotencyKey: 'dep002-exec-visit-1',
      },
    });
    expectOk(result, 'create visit execution', [201]);
    ids['execVisit'] = (result.body['execution'] as Record<string, unknown>)['executionId'] as string;
    created('execution', `visit ${ids['execVisit']} (human-kind, attempt ledger)`);
  } else {
    ids['execVisit'] = visitExecution['executionId'] as string;
    reused('execution', `visit ${ids['execVisit']}`);
  }

  // The REAL executed run: dispatch to the pooled path; the CONTINUOUS worker
  // process (staging-worker-1) claims the queue job and drives the execution
  // to a terminal verdict with a content-addressed output artifact.
  const dispatchRead = await api(`/api/executions/${ids['execPrep']}/dispatch`, { token: owner });
  if (dispatchRead.status === 200 && dispatchRead.body['dispatch'] !== null && dispatchRead.body['dispatch'] !== undefined) {
    const dispatch = dispatchRead.body['dispatch'] as Record<string, unknown>;
    reused('worker-executed run', `dispatch ${String(dispatch['dispatchId'])} (${String(dispatch['outcome'])})`);
  } else {
    const dispatch = await api(`/api/executions/${ids['execPrep']}/dispatch`, {
      token: owner,
      body: {
        taskKind: 'data.transform',
        input: {
          records: [
            { campaign: 'hangar-inspection-guide', spend: 412.5, leads: 9 },
            { campaign: 'compliance-checklist', spend: 187.25, leads: 5 },
            { campaign: 'retarget-website', spend: 96.0, leads: 2 },
          ],
          sortBy: 'spend',
        },
        idempotencyKey: 'dep002-dispatch-prep-1',
      },
    });
    expectOk(dispatch, 'dispatch prep execution to the pooled worker path', [201, 200]);
    created('dispatch', `queued execution ${ids['execPrep']} (taskKind data.transform)`);
  }
  // Wait for the worker to finish (terminal verdict).
  const terminal = await waitForTerminal(ids['execPrep'], owner);
  ids['execPrepStatus'] = terminal['status'] as string;
  info(`worker-executed run ${ids['execPrep']} → ${String(terminal['status'])}`);
  const finalDispatch = (await api(`/api/executions/${ids['execPrep']}/dispatch`, { token: owner })).body['dispatch'] as Record<string, unknown>;
  ids['execPrepOutputRef'] = (finalDispatch?.['outputRef'] as string) ?? '';
  info(`dispatch outcome: ${String(finalDispatch?.['outcome'])} · artifact ${ids['execPrepOutputRef'].slice(0, 16)}…`);
  const transitions = rowsOf(await api(`/api/executions/${ids['execPrep']}/transitions`, { token: owner }), 'transitions');
  info(`execution history: ${transitions.map((row) => `${String(row['fromStatus'])}→${String(row['toStatus'])}`).join(', ')}`);

  // --- 17. decisions (the full objective→…→outcome→learning chain) -----------------
  const decisionList = rowsOf(await api(`/api/clients/${ids['clientA']}/decisions`, { token: owner }), 'decisions');
  async function ensureDecision(objective: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const found = decisionList.find((row) => row['objective'] === objective);
    if (found !== undefined) return found;
    const result = await api(`/api/clients/${ids['clientA']}/decisions`, { token: owner, body: { ...body, objective } });
    expectOk(result, `decision ${objective.slice(0, 40)}…`, [201]);
    const decision = (result.body['decision'] as Record<string, unknown>);
    created('decision', `${objective.slice(0, 60)}… (${String(decision['decisionId'])})`);
    decisionList.push(decision);
    return decision;
  }

  // D1 — accepted + observed outcome (the full chain).
  const d1Objective = 'Roll out the five-touch onboarding sequence to all new Helio accounts';
  const d1 = await ensureDecision(d1Objective, {
    context: 'Q3 activation sat at 39%; the warehouse export and the onboarding experiment both point the same way.',
    hypothesisSummary: 'A five-touch onboarding email sequence increases new-account activation versus the three-touch sequence.',
    evidenceRefs: [ids['evidenceActivation'], ids['evidenceRevenue']],
    expectedImpact: {
      summary: 'New-account activation is expected to rise by roughly two points.',
      direction: 'increase',
      magnitude: '+2.1pp activation (42% vs 39.9%)',
    },
    uncertainty: { kind: 'interval', lower: 0.012, upper: 0.041, level: 0.95 },
    expectedCost: 'One additional email send per new account (~$0.003/account).',
    alternatives: ['Keep the three-touch sequence (status quo).', 'Roll out only to standard-tier accounts first.'],
    idempotencyKey: 'dep002-decision-1',
    workspaceId: ids['workspace'],
  });
  ids['decision1'] = d1['decisionId'] as string;
  if (d1['disposition'] === 'proposed') {
    const accepted = await api(`/api/decisions/${ids['decision1']}/disposition`, {
      token: owner,
      body: { command: 'accept', reason: 'Rolling out to all new accounts after the causal lift.', idempotencyKey: 'dep002-decision-1-accept' },
    });
    expectOk(accepted, 'accept decision 1', [200]);
    created('disposition', `decision 1 accepted`);
  } else {
    reused('disposition', `decision 1 ${String(d1['disposition'])}`);
  }
  const d1Fresh = (await api(`/api/decisions/${ids['decision1']}`, { token: owner })).body;
  if (d1Fresh['observedOutcome'] === null || d1Fresh['observedOutcome'] === undefined) {
    const outcome = await api(`/api/decisions/${ids['decision1']}/outcome`, {
      token: owner,
      body: {
        observedOutcome: {
          summary: 'Activation rose to 42%, in line with the expected interval.',
          asExpected: true,
          notes: 'Delivery was stable; no unsubscribe spike.',
        },
        executionRef: ids['execPrep'],
        learningRef: ids['learning1'],
        idempotencyKey: 'dep002-decision-1-outcome',
      },
    });
    expectOk(outcome, 'record decision 1 outcome', [200]);
    created('outcome', 'decision 1 observed (execution + learning linked)');
  } else {
    reused('outcome', 'decision 1 already observed');
  }

  // D2 — left PROPOSED (pending: feeds the decision room + attention surfaces).
  const d2 = await ensureDecision('Shift thirty percent of Atlas-sourced retargeting spend into localized industrial search', {
    context: 'Retargeting CPMs climbed 18% quarter-over-quarter while industrial-search conversion held steady.',
    hypothesisSummary: 'Localized industrial search converts Helio-sourced traffic at a lower effective CAC than retargeting at the margin.',
    evidenceRefs: [ids['evidenceActivation']],
    expectedImpact: {
      summary: 'Blended CAC expected to fall with unchanged lead volume.',
      direction: 'decrease',
      magnitude: 'CAC −8% at constant lead volume',
    },
    uncertainty: { kind: 'interval', lower: 0.03, upper: 0.13, level: 0.9 },
    expectedCost: 'One-time creative localisation for three regions.',
    alternatives: ['Hold the current retargeting mix.', 'Shift fifty percent for one month as a probe.'],
    idempotencyKey: 'dep002-decision-2',
  });
  ids['decision2'] = d2['decisionId'] as string;

  // D3 — rejected (decision-room history variety).
  const d3 = await ensureDecision('Offer a flat fifteen percent discount for annual prepayment', {
    context: 'Finance asked whether annual prepay discounts would accelerate the Q4 close plan.',
    hypothesisSummary: 'A flat 15% annual-prepay discount accelerates closes enough to offset the margin give.',
    evidenceRefs: [],
    expectedImpact: { summary: 'Close rate expected to rise modestly.', direction: 'increase', magnitude: '+5% close rate' },
    expectedCost: '15% margin give on prepaid accounts.',
    alternatives: ['Tiered prepay discounts (10%/12%/15%).', 'No discount; keep monthly terms.'],
    idempotencyKey: 'dep002-decision-3',
  });
  ids['decision3'] = d3['decisionId'] as string;
  if (d3['disposition'] === 'proposed') {
    const rejected = await api(`/api/decisions/${ids['decision3']}/disposition`, {
      token: owner,
      body: { command: 'reject', reason: 'Margin give outweighs the close-rate lift at current churn.', idempotencyKey: 'dep002-decision-3-reject' },
    });
    expectOk(rejected, 'reject decision 3', [200]);
    created('disposition', 'decision 3 rejected');
  } else {
    reused('disposition', `decision 3 ${String(d3['disposition'])}`);
  }

  // --- 18. AI runtime inputs (real margin figures for Profit Intelligence) ----------
  const models = rowsOf(await api('/api/ai/models', { token: admin }), 'models');
  const existingModel = models.find((row) => row['modelKey'] === 'northwind-copy-standard');
  if (existingModel !== undefined) {
    ids['model'] = existingModel['modelRegistryId'] as string;
    reused('AI model', `northwind-copy-standard (${ids['model']})`);
  } else {
    const result = await api('/api/ai/models', {
      token: admin,
      body: {
        providerLabel: 'northwind-labs',
        modelKey: 'northwind-copy-standard',
        displayName: 'Northwind Copy Standard',
        capabilities: ['text-generation', 'tool-use'],
        toolFeatures: ['function-calling'],
        contextLimitTokens: 128_000,
        costInputPerMtok: 3.5,
        costOutputPerMtok: 10.0,
        latencyP50Ms: 900,
        latencyP95Ms: 2400,
        reliability: 0.98,
        qualitySignals: { 'copywriting.generate': 0.87 },
        privacyCharacteristics: { dataResidency: 'eu', trainingUse: false },
      },
    });
    expectOk(result, 'register AI model', [201]);
    ids['model'] = result.body['modelRegistryId'] as string;
    created('AI model', `northwind-copy-standard (${ids['model']})`);
  }

  const taskProfiles = rowsOf(await api(`/api/workspaces/${ids['workspace']}/ai/task-profiles`, { token: owner }), 'taskProfiles');
  const existingProfile = taskProfiles.find((row) => row['taskClass'] === 'copywriting.generate');
  if (existingProfile !== undefined) {
    ids['taskProfile'] = existingProfile['taskProfileId'] as string;
    reused('task profile', `copywriting.generate (${ids['taskProfile']})`);
  } else {
    const result = await api(`/api/workspaces/${ids['workspace']}/ai/task-profiles`, {
      token: owner,
      body: {
        taskClass: 'copywriting.generate',
        qualityTarget: 'publication-ready',
        riskClass: 'medium',
        contextRequirements: { minInputTokens: 200, maxInputTokens: 8000 },
        latencyTargetMs: 30_000,
        maxCostPerInvocation: 0.25,
        privacyClass: 'internal',
        toolRequirements: ['web-search'],
        outputSchema: { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] },
        evaluatorIds: ['brand-voice-rubric'],
        escalationPolicy: { maxEscalations: 2, fallback: 'human-review' },
        idempotencyKey: 'dep002-task-profile-1',
      },
    });
    expectOk(result, 'register task profile', [201, 200]);
    ids['taskProfile'] = (result.body['taskProfile'] as Record<string, unknown>)['taskProfileId'] as string;
    created('task profile', `copywriting.generate (${ids['taskProfile']})`);
  }

  const telemetry = rowsOf(await api(`/api/workspaces/${ids['workspace']}/ai/usage-telemetry`, { token: owner }), 'usageTelemetry');
  if (telemetry.length > 0) {
    reused('usage telemetry', `${telemetry.length} row(s)`);
  } else {
    const result = await api(`/api/workspaces/${ids['workspace']}/ai/usage-telemetry`, {
      token: owner,
      body: {
        taskProfileId: ids['taskProfile'],
        modelRegistryId: ids['model'],
        executionId: ids['execPrep'],
        outcome: 'succeeded',
        latencyMs: 1234,
        costAmount: 0.0125,
        tokensIn: 1500,
        tokensOut: 420,
        escalationCount: 0,
        idempotencyKey: 'dep002-usage-1',
      },
    });
    expectOk(result, 'append usage telemetry', [201, 200]);
    created('usage telemetry', 'linked to the worker-executed run (cost $0.0125)');
  }

  // --- 19. field-agent job chain (the /jobs human marketplace surface) -------------
  const agentToken = sessions['agent']!;
  // DEP-006/DEP-007: the eligibility contract REQUIRES the availability window
  // (dayOfWeek/startMinute/endMinute); without it the probe 422s and re-runs
  // would wrongly fall through to profile creation (409 one-profile-per-user).
  const eligibility = await api(`/api/agencies/${agencyId}/field-agents/eligibility`, {
    token: owner,
    body: { specialization: 'field_agent', requiredCapabilities: ['canvassing'], territory: { kind: 'city', value: 'accra' }, dayOfWeek: 2, startMinute: 540, endMinute: 1020 },
  });
  const eligibleAgents = eligibility.status === 200 ? rowsOf(eligibility, 'agents') : [];
  if (eligibleAgents.length > 0) {
    ids['agentProfile'] = eligibleAgents[0]!['agentId'] as string;
    reused('human-agent profile', `${USERS.agent.email} (${ids['agentProfile']})`);
  } else {
    // Fallback for re-runs where the probe cannot match (e.g. the profile's
    // availability changed): reuse the cached profile id — verified through
    // the real self-read contract — before ever trying to create.
    const cachedProfileId = readSeedCache()['agentProfileId'];
    if (cachedProfileId !== undefined) {
      const cachedRead = await api(`/api/field-agents/${cachedProfileId}`, { token: agentToken });
      if (cachedRead.status === 200) {
        ids['agentProfile'] = cachedProfileId;
        reused('human-agent profile', `${USERS.agent.email} (${cachedProfileId}, cached)`);
      }
    }
  }
  if (ids['agentProfile'] === undefined) {
    const profile = await api('/api/field-agents', {
      token: agentToken,
      body: {
        specializations: ['field_agent'],
        capabilities: [{ skill: 'canvassing', level: 'advanced' }],
        availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }],
        location: { kind: 'city', value: 'accra' },
        territories: [],
        relationshipContinuity: { prefersRepeatClients: true, continuity: 'preferred', maxConcurrentClientRelationships: 4 },
      },
    });
    expectOk(profile, 'create human-agent profile', [201]);
    ids['agentProfile'] = profile.body['agentId'] as string;
    created('human-agent profile', `${USERS.agent.email} (${ids['agentProfile']})`);
  }

  // The projected job: reuse the completed one (verified through the job read).
  let jobId: string | null = null;
  const cachedJobId = readSeedCache()['jobId'];
  if (cachedJobId !== undefined) {
    const cached = await api(`/api/jobs/${cachedJobId}`, { token: owner });
    if (cached.status === 200) jobId = cachedJobId;
  }
  if (jobId === null) {
    const projected = await api(`/api/workflows/${workflowId}/instances/${ids['instance']}/jobs`, {
      token: owner,
      body: {
        nodeId: 'visit',
        title: 'Field visit — collect signed inspection feedback at the Helio hangar',
        description: 'Visit the hangar, collect the signed feedback form, capture photos of the inspection line.',
        specialization: 'field_agent',
        requiredCapabilities: ['canvassing'],
        territory: { kind: 'city', value: 'accra' },
        dayOfWeek: 2,
        startMinute: 540,
        endMinute: 1020,
      },
    });
    expectOk(projected, 'project field-visit job', [201]);
    jobId = projected.body['jobId'] as string;
    created('job', `field visit (${jobId})`);
  } else {
    reused('job', `field visit (${jobId})`);
  }
  ids['job'] = jobId;

  const jobRead = (await api(`/api/jobs/${jobId}`, { token: owner })).body;
  const jobStatus = jobRead['status'] as string | undefined;
  // DEP-007: include 'projected' — the DEP-005 run projected the field-visit
  // job but the chain below never ran (a freshly projected job reads
  // 'projected', not 'open'), so the production job sat unclaimed in the
  // marketplace. Running the chain (real offer → accept → outcome contracts)
  // brings the production demo story to full parity with staging, where the
  // field-visit job ends TERMINAL with evidence. After the outcome the status
  // is terminal, so re-runs take the reused branch (idempotent).
  if (jobStatus === undefined || jobStatus === 'projected' || jobStatus === 'open' || jobStatus === 'offered') {
    const offer = await api(`/api/jobs/${jobId}/offers`, {
      token: owner,
      body: { candidateAgentId: ids['agentProfile'], expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    });
    expectOk(offer, 'create job offer', [201]);
    const offerId = offer.body['offerId'] as string;
    const accepted = await api(`/api/jobs/${jobId}/offers/${offerId}/accept`, { token: agentToken, body: {} });
    expectOk(accepted, 'accept job offer', [200]);
    const outcome = await api(`/api/jobs/${jobId}/outcome`, {
      token: agentToken,
      body: { outcome: 'succeeded', evidenceRef: ids['evidenceVisit'] },
    });
    expectOk(outcome, 'submit job outcome', [201]);
    created('job chain', `offer → accept → outcome succeeded (evidence ${ids['evidenceVisit']})`);
  } else {
    reused('job chain', `field visit job is ${jobStatus}`);
  }

  // --- 19b. a LIVE open offer in the human-work queue (DEP-006 D5 top-up,
  // DEP-006b hardening — ported to production by DEP-007 for full staging
  // parity). The chain above ends terminal (offer → accept → outcome), so a
  // fresh visitor's "My queue" would be empty. This fixture projects a human
  // Task into a Job (one Job per Task projection — a dedicated RUNNING
  // instance is required; the delivered run's visit Task is taken) and gives
  // the demo agent a long-lived OPEN offer — never accepted by the seed — so
  // Sam's queue always shows an actionable item.
  //
  // DEP-006b: the fixture can be CONSUMED by demo viewers (accepting the
  // offer in the UI claims the job; declining closes the round). When the
  // previous fixture job was accepted, its chain is closed out honestly
  // FIRST (the original DEP-002 pattern: offer → accept → OUTCOME, submitted
  // by the accepted agent through the real contract — replay converges), and
  // a FRESH fixture is projected. Only 'projected'/'offered' jobs can carry
  // a new offer (the contract 409s otherwise), so reuse is gated on that.
  // Every call here is a synchronous command through the deployed bridge —
  // no queued execution is involved, so no drain-kick wait is needed.
  const followupTitle = 'Field follow-up — deliver the printed inspection summary at the Helio hangar';
  const cachedOpenJobId = readSeedCache()['openJobId'];
  if (cachedOpenJobId !== undefined) {
    const cachedRead = await api(`/api/jobs/${cachedOpenJobId}`, { token: owner });
    if (cachedRead.status === 200 && cachedRead.body['status'] === 'accepted') {
      const outcome = await api(`/api/jobs/${cachedOpenJobId}/outcome`, {
        token: agentToken,
        body: { outcome: 'succeeded', evidenceRef: ids['evidenceVisit'] },
      });
      expectOk(outcome, 'close out accepted fixture job', [200, 201]);
      created('fixture job outcome', `succeeded (${cachedOpenJobId}) — the accepted queue fixture was closed out by the demo accept`);
    }
  }

  // Reuse an OFFERABLE follow-up job (the marketplace lists projected/offered
  // jobs only), else project a fresh fixture.
  const marketplaceJobs = rowsOf(await api('/api/jobs/marketplace', { token: agentToken }), 'jobs');
  let openJob = marketplaceJobs.find((row) => row['title'] === followupTitle);
  if (openJob === undefined && cachedOpenJobId !== undefined) {
    const cachedRead = await api(`/api/jobs/${cachedOpenJobId}`, { token: owner });
    const cachedStatus = cachedRead.status === 200 ? String(cachedRead.body['status']) : '';
    if (cachedStatus === 'projected' || cachedStatus === 'offered') {
      openJob = cachedRead.body;
    }
  }
  let openJobId: string | null = null;
  if (openJob !== undefined) {
    openJobId = openJob['jobId'] as string;
    reused('open-queue job', `field follow-up (${openJobId}, ${String(openJob['status'])})`);
  } else {
    const openInstance = await api(`/api/workflows/${workflowId}/definitions/${definitionId}/instances`, { token: owner, body: {} });
    expectOk(openInstance, 'create queue-fixture instance', [201]);
    const openInstanceId = openInstance.body['workflowInstanceId'] as string;
    let openVersion = openInstance.body['version'] as number;
    for (const to of ['ready', 'running'] as const) {
      const transition = await api(`/api/workflows/${workflowId}/instances/${openInstanceId}/transitions`, {
        token: owner,
        body: { to, version: openVersion, idempotencyKey: `dep006-queue-inst-${to}-${openInstanceId}` },
      });
      expectOk(transition, `queue-fixture instance → ${to}`, [200]);
      openVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
    }
    ids['openInstance'] = openInstanceId;
    created('workflow instance', `running ${openInstanceId} (human-work queue fixture)`);
    const projected = await api(`/api/workflows/${workflowId}/instances/${openInstanceId}/jobs`, {
      token: owner,
      body: {
        nodeId: 'visit',
        title: followupTitle,
        description: 'Deliver the printed summary to the operations desk and collect the signed acknowledgment slip.',
        specialization: 'field_agent',
        requiredCapabilities: ['canvassing'],
        territory: { kind: 'city', value: 'accra' },
        dayOfWeek: 2,
        startMinute: 540,
        endMinute: 1020,
      },
    });
    expectOk(projected, 'project follow-up job', [201]);
    openJobId = projected.body['jobId'] as string;
    created('open-queue job', `field follow-up (${openJobId})`);
  }
  ids['openJob'] = openJobId;

  const liveOffers = rowsOf(await api(`/api/jobs/${openJobId}/offers`, { token: owner }), 'offers')
    .filter((row) => row['candidateAgentId'] === ids['agentProfile'] && row['status'] === 'open');
  if (liveOffers.length > 0) {
    reused('open queue offer', `${liveOffers[0]!['offerId'] as string}`);
  } else {
    const offer = await api(`/api/jobs/${openJobId}/offers`, {
      token: owner,
      body: { candidateAgentId: ids['agentProfile'], expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() },
    });
    expectOk(offer, 'create open queue offer', [201]);
    created('open queue offer', `${offer.body['offerId'] as string} for ${USERS.agent.email}`);
  }

  // --- 20. the four MKT-051 first-party packs --------------------------------------
  const manifests = allFirstPartyManifests();
  info(`first-party manifests available: ${manifests.map((m) => `${m.appKey}@${m.version}`).join(', ')}`);
  const catalog = rowsOf(await api('/api/apps', { token: admin }), 'apps');
  // DEP-006/DEP-007: the /api/apps catalog rows carry the version inside
  // manifest.version (not as a top-level key) — read it there or every
  // re-run would wrongly re-publish (409 immutable).
  const published = new Set(
    catalog.map((row) => {
      const manifest = row['manifest'] as Record<string, unknown> | undefined;
      return `${String(row['appKey'])}@${String(manifest?.['version'] ?? row['version'])}`;
    }),
  );
  for (const manifest of manifests) {
    const key = `${manifest.appKey}@${manifest.version}`;
    if (published.has(key)) {
      reused('app publish', key);
      continue;
    }
    // HTTP transport: networkDestinations.port arrives as a STRING (the route
    // DTO converts back); the signature covers the ORIGINAL typed manifest.
    const transportManifest = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    const destinations = transportManifest['networkDestinations'] as Record<string, unknown>[];
    for (const destination of destinations) {
      destination['port'] = String(destination['port']);
    }
    const result = await api('/api/apps', {
      token: INTERNAL_API_TOKEN,
      body: {
        manifest: transportManifest,
        signature: signManifest(manifest),
        idempotencyKey: `dep002-publish-${manifest.appKey}-${manifest.version}`,
      },
    });
    expectOk(result, `publish ${key}`, [201]);
    created('app publish', `${key} (publisher ${String(result.body['publisher'])}, ${String(result.body['certificationState'])})`);
  }

  // Trust ladder: UNVERIFIED → COMMUNITY_VERIFIED → MOS_CERTIFIED (real command path).
  const listing = expectOk(await api(`/api/app-marketplace/${agencyId}/apps?publisherKind=first-party`, { token: owner }), 'marketplace listing');
  const listedApps = (listing.body['apps'] ?? listing.body['entries']) as Record<string, unknown>[];
  for (const appKey of APP_KEYS) {
    const entry = listedApps.find((row) => row['appKey'] === appKey);
    const trustLevel = (entry?.['trustState'] as Record<string, unknown> | undefined)?.['trustLevel'] as string | undefined;
    if (trustLevel === 'MOS_CERTIFIED') {
      reused('trust', `${appKey} MOS_CERTIFIED`);
      continue;
    }
    if (trustLevel === 'UNVERIFIED') {
      const verify = await api(`/api/app-marketplace/apps/${appKey}/trust`, {
        token: admin,
        body: { transition: 'verify', reason: 'DEP-002 first-party program verification round', idempotencyKey: `dep002-verify-${appKey}` },
      });
      expectOk(verify, `verify ${appKey}`, [201, 200]);
      created('trust', `${appKey} → COMMUNITY_VERIFIED`);
    }
    const certify = await api(`/api/app-marketplace/apps/${appKey}/trust`, {
      token: admin,
      body: { transition: 'certify', reason: 'DEP-002 first-party program certification', idempotencyKey: `dep002-certify-${appKey}` },
    });
    expectOk(certify, `certify ${appKey}`, [201, 200]);
    created('trust', `${appKey} → MOS_CERTIFIED`);
  }

  // Install all four packs into the demo workspace (server-derived grants).
  const packs = rowsOf(await api(`/api/first-party-apps/workspaces/${ids['workspace']}/packs`, { token: owner }), 'packs');
  for (const appKey of APP_KEYS) {
    const pack = packs.find((row) => row['appKey'] === appKey);
    const selection = pack?.['currentSelection'] as Record<string, unknown> | null | undefined;
    if (selection != null) {
      reused('app install', `${appKey} @ ${String(selection['version'])}`);
      continue;
    }
    const install = await api(`/api/workspaces/${ids['workspace']}/app-installs`, {
      token: owner,
      body: { appKey, version: INSTALL_VERSION, idempotencyKey: `dep002-install-${appKey}` },
    });
    expectOk(install, `install ${appKey}`, [201, 200]);
    const record = install.body['install'] as Record<string, unknown>;
    created(
      'app install',
      `${appKey} @ ${String(record['version'])} (data: ${JSON.stringify(record['grantedDataScopes'])}, mutations: ${JSON.stringify(record['grantedMutationScopes'])})`,
    );
  }

  // =========================================================================
  // 21. VERIFY the live surfaces (read-only; print the evidence)
  // =========================================================================
  info('--- surface verification (read-only) ---');

  const commandCenter = await api(`/api/reporting/command-center/${agencyId}`, { token: owner });
  expectOk(commandCenter, 'command center');
  // DEP-007: the command-center contract carries clients under
  // workflowState.perClient (and goal counts under portfolioGoals) — there is
  // no top-level "clients" key (the old print always said 0).
  const ccWorkflowState = (commandCenter.body['workflowState'] as Record<string, unknown> | undefined) ?? {};
  const ccClients = (ccWorkflowState['perClient'] as Record<string, unknown>[]) ?? [];
  const ccActiveGoals = ((commandCenter.body['portfolioGoals'] as Record<string, unknown> | undefined)?.['goalStatusCounts'] as Record<string, unknown> | undefined)?.['active'];
  info(`command-center: ${ccClients.length} client(s): ${ccClients.map((c) => String(c['clientId'])).join(' · ')} · ${String(ccActiveGoals)} active goal(s)`);

  const decisionRoom = await api(`/api/reporting/decision-room/${ids['clientA']}`, { token: owner });
  expectOk(decisionRoom, 'decision room');
  const drDecisions = (decisionRoom.body['decisions'] as Record<string, unknown>[] | undefined) ?? [];
  const drAll = JSON.stringify(decisionRoom.body);
  info(`decision-room: ${drDecisions.length} listed decision record(s); payload ${drAll.length} bytes`);

  const profit = await api(`/api/profit-intelligence/${agencyId}/clients/${ids['clientA']}`, { token: owner });
  expectOk(profit, 'profit intelligence');
  const profitSummary = JSON.stringify(profit.body);
  const revenueBlock = (profit.body['revenue'] as Record<string, unknown> | undefined);
  info(`profit-intelligence: revenue block present=${revenueBlock !== undefined} · payload ${profitSummary.length} bytes`);
  const margin = profit.body['margin'] as Record<string, unknown> | undefined;
  if (margin !== undefined) {
    info(`margin: ${JSON.stringify(margin).slice(0, 400)}`);
  }

  const attention = await api(`/api/ai-operator/${agencyId}/attention-queue`, { token: owner });
  expectOk(attention, 'attention queue');
  const items = (attention.body['items'] as Record<string, unknown>[]) ?? [];
  info(`ai-operator attention queue: ${items.length} item(s): ${items.slice(0, 6).map((i) => String(i['category'])).join(', ')}${items.length > 6 ? ' …' : ''}`);

  const marketplaceAfter = expectOk(await api(`/api/app-marketplace/${agencyId}/apps`, { token: owner }), 'marketplace after');
  const listed = ((marketplaceAfter.body['apps'] ?? marketplaceAfter.body['entries']) as Record<string, unknown>[]).filter(
    (row) => (row['publisherKind'] as string | undefined) === 'first-party',
  );
  info(`marketplace: ${listed.length} first-party app(s): ${listed.map((row) => `${String(row['appKey'])}(${String((row['trustState'] as Record<string, unknown>)['trustLevel'])})`).join(' · ')}`);

  const packsAfter = rowsOf(await api(`/api/first-party-apps/workspaces/${ids['workspace']}/packs`, { token: owner }), 'packs');
  info(`installed packs: ${packsAfter.length} — ${packsAfter.map((row) => `${String(row['appKey'])}@${String((row['currentSelection'] as Record<string, unknown> | null)?.['version'] ?? '—')}`).join(' · ')}`);

  // --- write the seed cache + report ------------------------------------------
  writeSeedCache({ jobId: ids['job'], agentProfileId: ids['agentProfile'], openJobId: ids['openJob'], seededAt: new Date().toISOString() });
  const report = {
    seededAt: new Date().toISOString(),
    base: BASE,
    agency: { name: AGENCY_NAME, agencyId },
    ids,
    changes,
    reuses,
    surfaces: {
      commandCenterClients: ccClients.length,
      decisionRoomBytes: drAll.length,
      profitRevenuePresent: revenueBlock !== undefined,
      attentionItems: items.length,
      marketplaceFirstParty: listed.length,
      installedPacks: packsAfter.length,
      executedRun: { executionId: ids['execPrep'], status: ids['execPrepStatus'], outputRef: ids['execPrepOutputRef'] },
    },
  };
  fs.writeFileSync(path.join(SERVICE_DIR, 'var', 'seed-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(SERVICE_DIR, 'var', 'seeded.json'), `${JSON.stringify({ seededAt: report.seededAt, agencyId, changes: changes.length }, null, 2)}\n`);

  info(`DONE — ${changes.length} creation(s), ${reuses.length} reused. Report: var/seed-report.json`);
  if (changes.length === 0) {
    info('IDEMPOTENT RE-RUN: no changes were made.');
  }
}

async function waitForTerminal(executionId: string, token: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 90_000;
  let lastKick = 0;
  for (;;) {
    const result = await api(`/api/executions/${executionId}`, { token });
    if (result.status === 200) {
      const status = result.body['status'] as string;
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(status)) {
        return result.body;
      }
    }
    // DEP-005: production has no continuous worker — kick the admin-gated
    // bounded drain while the execution is still in flight (max once / 5s).
    if (Date.now() - lastKick > 5_000) {
      lastKick = Date.now();
      const drain = await fetch(`${BASE}/api/mos-admin/drain?budgetMs=30000`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INTERNAL_API_TOKEN}` },
      });
      const drainText = (await drain.text()).slice(0, 300);
      process.stdout.write(`[seed] drain kick: HTTP ${drain.status} ${drainText}\n`);
    }
    if (Date.now() > deadline) {
      throw new Error(`execution ${executionId} did not reach a terminal verdict within 90s (last: ${JSON.stringify(result.body).slice(0, 200)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

interface SeedCache {
  jobId?: string;
  agentProfileId?: string;
  /** DEP-007: the step-19b live-queue fixture job (Sam's open offer). */
  openJobId?: string;
  seededAt?: string;
}

function readSeedCache(): SeedCache {
  try {
    return JSON.parse(fs.readFileSync(path.join(SERVICE_DIR, 'var', 'seed-cache.json'), 'utf8')) as SeedCache;
  } catch {
    return {};
  }
}

function writeSeedCache(cache: SeedCache): void {
  const merged = { ...readSeedCache(), ...cache };
  fs.mkdirSync(path.join(SERVICE_DIR, 'var'), { recursive: true });
  fs.writeFileSync(path.join(SERVICE_DIR, 'var', 'seed-cache.json'), `${JSON.stringify(merged, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[seed] FAILED: ${String(error)}\n`);
  process.exit(1);
});
