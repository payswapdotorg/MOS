/**
 * MKT-034 integration test — THE END-TO-END ACQUISITION OPERATING LOOP on
 * the real stack (embedded PostgreSQL 18 + real API subprocess + real
 * drain-mode worker subprocess + the wiring service constructed IN-PROCESS
 * through bootstrapApplication() against the SAME database the API serves
 * — the sanctioned test-harness wiring of the MKT-028/MKT-038 precedents;
 * the remaining flow is driven through the real HTTP API).
 *
 * Acceptance mapping (work-item-matrix.md MKT-034 = E2E-001, acceptance
 * E2E-AC-01 — "a complete pilot can execute using at least one AI path,
 * one human field-agent path, and one extension path with a shared
 * Goal/Workflow/Evidence lifecycle — end-to-end integration test"):
 *
 * THE GOLDEN PATH (E2E-AC-01) — ONE pilot scenario, every hop crossing the
 * authority boundaries exactly as the frozen contracts specify:
 *
 *   EXTENSION BOUNDARY PREP (MKT-032/MKT-022): a platform_developer
 *   publishes the loop's extension version through the portal; the agency
 *   owner runs the PERMISSION REVIEW and approves (the delegated
 *   /policies declaration carries the version-scoped allow rule); the
 *   reviewed version installs in the loop Workspace (grantedScopes ⊆
 *   manifest scopes); configure validates the manifest config contract and
 *   binds the required secret LOGICAL NAME to a credential REFERENCE
 *   (CRED-001 — never material); authorize enables the install.
 *
 *   AI RUNTIME PREP (MKT-017/018): a Workspace-scoped TaskProfile through
 *   the /ai-runtime surface; a platform model-registry entry through the
 *   /ai-runtime surface.
 *
 *   Goal (active, workspace-scoped) → deployAcquisitionLoop (playbook
 *   version PUBLISHED + workflow definition ACTIVE + §16 experiment
 *   declared, all through the authority publics) → bounded instance start
 *   (the five fail-closed bounds) → THE THREE PATHS UNDER ONE WORKFLOW
 *   INSTANCE (the shared Goal/Workflow/Evidence lifecycle):
 *     - AI PATH: /executions AI-class runtime attempt for the template's
 *       ai_task node + the AI Router (routeTask through the module public
 *       with the test-harness fake adapter — the sanctioned wiring) runs
 *       the cheap-first cascade to a VALIDATED output; the execution
 *       reaches SUCCEEDED through the /executions transition surface;
 *     - FIELD PATH: §18 Job projected from the template's human_task node,
 *       offered to an eligible field agent, accepted, visit opened/
 *       started, field evidence captured, structured outcome completed,
 *       job outcome submitted with required evidence;
 *     - EXTENSION PATH: /executions extension-kind runtime attempt for the
 *       template's extension_capability node + the §19 invocation context
 *       derived through the /extensions public (scope SERVER-DERIVED from
 *       the execution's canonical owner; the fail-closed policy gate
 *       records an explicit allow) + the pooled dispatch through the real
 *       HTTP route drained by a REAL worker subprocess → SUCCEEDED with a
 *       content-addressed artifact.
 *
 *   EVIDENCE under the SHARED lifecycle: per-leg observations (AI output,
 *   extension invocation + artifact) + the §18 field evidence + the
 *   commissioning-side loop outcome source_fact → /metrics observations
 *   with evidence provenance → guardrail evaluation (not breached) → §16
 *   experiment CONCLUDED with a resulting decision citing the same-Client
 *   evidence → §17 LEARNING appended citing the evidence + the CONCLUDED
 *   experiment → the workflow instance reaches its terminal state through
 *   the /workflows authority → THE CLIENT DECISION ROOM (MKT-030) surfaces
 *   the whole loop: what happened (goal + instance), why (the learning),
 *   evidence quality, the experiment decision, recommendations and
 *   approvals → the derived loop status re-reads the full chain from the
 *   authorities.
 *
 * NEGATIVE TESTS (authority-boundary evidence — every hop with bypassed or
 * insufficient authority FAILS at the authority and leaves reconcilable
 * state, never silent success):
 *   - PERMISSION BYPASS: a foreign agency's owner installing the reviewed
 *     version is denied AT THE AUTHORITY (403 POLICY_DENIED from inside
 *     installExtension — the agency-scoped approval does not compose
 *     across agencies) with ZERO install rows;
 *   - FORGED LIFECYCLE: installed → authorized is the authority 409 (the
 *     frozen install transition table); an invocation against a
 *     CONFIGURED-but-not-AUTHORIZED install is the authority 409 with
 *     ZERO invocation ledger rows and the execution left non-terminal
 *     (reconcilable);
 *   - INVOCATION GUARDS: an undeclared capability is 422; an
 *     authority-shaped input key is 422; a foreign-workspace caller on the
 *     invocation route is the uniform 404; a TERMINAL execution refuses
 *     invocation (409 — a dead execution cannot mint contexts);
 *   - FIELD TENANT ISOLATION: a foreign tenant reading the loop's §18 job
 *     over HTTP is the uniform 404;
 *   - AI HOP FENCE: routing with a FOREIGN workspace's TaskProfile is the
 *     uniform NotFoundError at the composition pre-fence;
 *   - LOOP FENCES: a conclusion citing CROSS-CLIENT evidence is the
 *     uniform 404 and the experiment stays RUNNING with its transition
 *     history intact (no partial begin_analysis — fail-closed BEFORE the
 *     write); the live-instance cap blocks a concurrent second start; a
 *     Learning citing a NON-CONCLUDED experiment is rejected (422-class)
 *     with ZERO learning rows; a Learning citing FOREIGN evidence is the
 *     uniform 404.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  spawnWorker,
  waitFor,
  type ApiCallResult,
  type IntegrationStack,
} from './helpers/harness.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import { defaultValidator } from '../../src/modules/ai-runtime/public.ts';
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from '../../src/modules/ai-runtime/public.ts';
import { AcquisitionLoopFlow } from '../../src/workers/acquisition-loop/loop-flow.ts';
import type { AcquisitionLoopDeployment } from '../../src/workers/acquisition-loop/contract.ts';
import { LOOP_EXTENSION_NODE, LOOP_FIELD_NODE, LOOP_AI_NODE } from '../../src/workers/acquisition-loop/contract.ts';
import {
  LOOP_GUARDRAIL_COST,
  LOOP_PRIMARY_METRIC,
  buildExtensionManifest,
} from '../../src/workers/acquisition-loop/template.ts';
import { ConflictError, InvalidRequestError, NotFoundError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PASSWORD = 'a-very-long-password-123';
const SECRET_HANDLE = 'loop-audience-sync-key';
const SECRET_MATERIAL = 'MATERIAL-do-not-leak-loop-9d4f2a71';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let flow: AcquisitionLoopFlow | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

// ---------------------------------------------------------------------------
// The AI-path fake provider adapter (the sanctioned test-harness wiring:
// the ProviderAdapter PORT with the composition-root-supplied real adapter
// replaced by a fake — the frozen MKT-018 route contract).
// ---------------------------------------------------------------------------

const AI_QUALIFIED_COUNT = 3;
const AI_TOP_PROSPECT = 'prospect-p2';

class LoopFakeScoringAdapter implements ProviderAdapter {
  readonly providerLabel = 'loop-labs';
  /** The model-side invocations the cascade made (the request record). */
  readonly invocations: AdapterRequest[] = [];
  /** The model outputs returned (the validator-accepted payloads). */
  readonly outputs: Readonly<Record<string, unknown>>[] = [];
  async invoke(request: AdapterRequest): Promise<AdapterResponse> {
    this.invocations.push(request);
    const output = { qualified_count: AI_QUALIFIED_COUNT, top_prospect: AI_TOP_PROSPECT };
    this.outputs.push(output);
    return {
      ok: true,
      output,
      error: null,
      latencyMs: 120,
      costAmount: 0.002,
      tokensIn: 280,
      tokensOut: 40,
    };
  }
}

before(async () => {
  stack = await bootStack('acqloop');
  fs.writeFileSync(path.join(stack.env.secretsDir, `${SECRET_HANDLE}.secret`), SECRET_MATERIAL, { mode: 0o600 });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-028/MKT-038 precedent):
  // bootstrap the SAME application in-process (same embedded PostgreSQL
  // the API subprocess serves) and construct the acquisition-loop
  // composition service over the module public contracts.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  flow = new AcquisitionLoopFlow({
    goals: core.modules.goals,
    playbooks: core.modules.playbooks,
    workflows: core.modules.workflows,
    executions: core.modules.executions,
    jobs: core.modules.jobs,
    evidence: core.modules.evidence,
    metrics: core.modules.metrics,
    experiments: core.modules.experiments,
    extensions: core.modules.extensions,
    aiRuntime: core.modules.aiRuntime,
    learnings: core.modules.learnings,
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

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

interface Principal {
  readonly token: string;
  readonly userId: string;
}

async function makeUser(email: string): Promise<Principal> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201);
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, { token: admin, body: { password: PASSWORD } });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { token: login.body['token'] as string, userId };
}

interface Tenant {
  readonly owner: Principal;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
}

async function makeTenant(label: string): Promise<Tenant> {
  const owner = await makeUser(`${label}-owner@acqloop.test`);
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${label}`, ownerUserId: owner.userId },
  });
  assert.equal(agency.status, 201);
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

/** A platform developer principal (the frozen platform_developer role). */
async function makeDeveloper(email: string): Promise<Principal> {
  const principal = await makeUser(email);
  const admin = await adminToken();
  const grant = await apiCall(port(), `/api/users/${principal.userId}/platform-roles`, {
    token: admin,
    body: { role: 'platform_developer' },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  return principal;
}

/** Creates an ACTIVE workspace-scoped Goal through the /goals HTTP surface. */
async function makeActiveGoal(tenant: Tenant, label: string): Promise<{ goalId: string; version: number }> {
  const create = await apiCall(port(), `/api/clients/${tenant.clientId}/goals`, {
    token: tenant.owner.token,
    body: {
      objective: `Acquisition loop goal ${label}: prove the AI + field + extension motion within the cost guardrail`,
      workspaceId: tenant.workspaceId,
      successCriteria: [
        {
          metric: LOOP_PRIMARY_METRIC.name,
          comparator: '>=',
          targetValue: 1,
          unit: 'count',
          description: 'at least one qualified lead within the loop window',
        },
      ],
      metrics: [],
      constraints: [{ kind: 'resource', description: 'loop cost within the declared guardrail' }],
      timeHorizon: null,
    },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const goalId = create.body['goalId'] as string;
  const version = create.body['version'] as number;
  const activate = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token: tenant.owner.token,
    method: 'PATCH',
    body: { status: 'active', version },
  });
  assert.equal(activate.status, 200, JSON.stringify(activate.body));
  return { goalId, version: activate.body['version'] as number };
}

/** Deploys the loop for a fresh active goal of a fresh tenant. */
async function makeDeployedLoop(label: string): Promise<{
  tenant: Tenant;
  goalId: string;
  deployment: AcquisitionLoopDeployment;
}> {
  const tenant = await makeTenant(label);
  const goal = await makeActiveGoal(tenant, label);
  const deployment = await flow!.deployAcquisitionLoop({
    goalId: goal.goalId,
    actorId: tenant.owner.userId,
    correlation: { correlationId: `loop-deploy-${label}`, causationId: null },
  });
  return { tenant, goalId: goal.goalId, deployment };
}

/** One eligible field agent principal + profile (matches the template eligibility). */
async function makeFieldAgent(email: string): Promise<Principal & { agentId: string }> {
  const principal = await makeUser(email);
  const created = await apiCall(port(), '/api/field-agents', {
    token: principal.token,
    body: {
      specializations: ['field_agent'],
      capabilities: [{ skill: 'canvassing', level: 'advanced' }],
      availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }],
      location: { kind: 'city', value: 'accra' },
      territories: [],
      relationshipContinuity: {
        prefersRepeatClients: true,
        continuity: 'preferred',
        maxConcurrentClientRelationships: 4,
      },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { ...principal, agentId: created.body['agentId'] as string };
}

/** Creates an extension-kind execution through the §7 external-request linkage (HTTP). */
async function makeExtensionExecution(workspaceId: string, token: string, ref: string): Promise<string> {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token,
    body: {
      externalRequestRef: ref,
      executionKind: 'extension',
      runtimeClass: 'pooled-worker',
      idempotencyKey: `loop-exec-${ref}`,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
}

async function getExecution(executionId: string, token: string): Promise<ApiCallResult> {
  return apiCall(port(), `/api/executions/${executionId}`, { token });
}

async function waitTerminalExecution(executionId: string, token: string): Promise<Record<string, unknown>> {
  const result = await waitFor(
    `execution ${executionId} terminal`,
    async () => getExecution(executionId, token),
    (r) => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(r.body['status'] as string),
  );
  return result.body;
}

async function appendMetric(
  tenant: Tenant,
  metricName: string,
  value: number,
  unit: string,
  evidenceRef: string | null,
): Promise<void> {
  const response = await apiCall(port(), `/api/clients/${tenant.clientId}/metrics`, {
    token: tenant.owner.token,
    body: {
      metricName,
      dimensions: { loop: 'acquisition' },
      value,
      unit,
      sourceSystem: 'acquisition-loop',
      sourceRef: 'loop-instance',
      observedAt: new Date().toISOString(),
      quality: 'ok',
      ...(evidenceRef === null ? {} : { evidenceRef }),
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
}

/** The AI TaskProfile body (the loop's prospect-scoring request contract). */
function taskProfileBody(idempotencyKey: string): Record<string, unknown> {
  return {
    taskClass: 'acq.prospect_scoring',
    qualityTarget: 'outreach-ready',
    riskClass: 'medium',
    contextRequirements: { minInputTokens: 100, maxInputTokens: 4000 },
    latencyTargetMs: 30_000,
    maxCostPerInvocation: 0.25,
    privacyClass: 'internal',
    toolRequirements: [],
    outputSchema: {
      type: 'object',
      properties: {
        qualified_count: { type: 'number', description: 'qualified prospects of the scoring run' },
        top_prospect: { type: 'string', description: 'the highest-scoring prospect' },
      },
      required: ['qualified_count'],
    },
    evaluatorIds: [],
    escalationPolicy: { maxEscalations: 1, fallback: 'human-review' },
    idempotencyKey,
  };
}

/** The platform model-registry body (the loop's eligible scoring model). */
function modelBody(): Record<string, unknown> {
  return {
    providerLabel: 'loop-labs',
    modelKey: 'loop-score-model',
    displayName: 'Loop Score Model',
    capabilities: ['text-generation'],
    toolFeatures: [],
    contextLimitTokens: 32_000,
    costInputPerMtok: 1.5,
    costOutputPerMtok: 4.0,
    latencyP50Ms: 700,
    latencyP95Ms: 1800,
    reliability: 0.97,
    qualitySignals: { 'acq.prospect_scoring': 0.91 },
    privacyCharacteristics: { dataResidency: 'eu', trainingUse: false },
  };
}

// Shared state built by the golden path (tests run sequentially in file
// order; later negative tests consume the golden artifacts).
interface SharedState {
  tenant: Tenant;
  extensionId: string;
  installId: string;
  deployment: AcquisitionLoopDeployment;
  workflowId: string;
  workflowInstanceId: string;
  goldenExtensionExecutionId: string;
  extensionOutputRef: string;
  jobId: string;
  fieldEvidenceId: string;
  aiEvidenceId: string;
  extensionEvidenceId: string;
  outcomeEvidenceId: string;
  experimentId: string;
  learningId: string;
}
let shared: SharedState | null = null;
function state(): SharedState {
  if (shared === null) throw new Error('shared state not built');
  return shared;
}

function errorCode(body: Record<string, unknown>): string {
  return ((body['error'] as Record<string, unknown> | undefined)?.['code'] as string | undefined) ?? '';
}

// ---------------------------------------------------------------------------
// THE GOLDEN PATH — E2E-AC-01 end-to-end operating-loop evidence
// ---------------------------------------------------------------------------

test('E2E-AC-01 golden path: extension boundary → AI Runtime task → §18 field Job → §19 extension action under ONE instance → shared Evidence → metrics → experiment decision → Learning → Client Decision Room', async () => {
  const tenant = await makeTenant('golden');

  // ---- MKT-032/MKT-022: publish → permission review → install →
  // configure → authorize (the extension leg's authority chain) ----------
  const developer = await makeDeveloper('loop-developer@acqloop.test');
  const publish = await apiCall(port(), '/api/extension-portal/versions', {
    token: developer.token,
    body: { manifest: buildExtensionManifest(), idempotencyKey: 'loop-register-ext-1' },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  const extensionId = publish.body['extensionId'] as string;

  // The permission review approval is the delegated /policies declaration
  // (the version-scoped allow rule for install + invoke).
  const review = await apiCall(
    port(),
    `/api/extension-portal/agencies/${tenant.agencyId}/versions/${extensionId}/permission-review`,
    {
      token: tenant.owner.token,
      body: { decision: 'approve', reason: 'loop extension: least-privilege claims reviewed and accepted' },
    },
  );
  assert.equal(review.status, 201, JSON.stringify(review.body));
  const rules = ((review.body as Record<string, unknown>)['policy'] as Record<string, unknown>)['rules'] as Record<
    string,
    unknown
  >[];
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!['effect'], 'allow');
  assert.deepEqual(rules[0]!['operations'], ['install', 'invoke']);
  assert.equal(rules[0]!['resource'], 'acq-audience-sync');

  const install = await apiCall(port(), `/api/extension-portal/workspaces/${tenant.workspaceId}/installs`, {
    token: tenant.owner.token,
    body: { extensionId, grantedScopes: ['client:read'], idempotencyKey: 'loop-install-1' },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const installRecord = (install.body as Record<string, unknown>)['install'] as Record<string, unknown>;
  const installId = installRecord['installId'] as string;
  assert.equal(installRecord['status'], 'installed');
  assert.equal(installRecord['workspaceId'], tenant.workspaceId);

  // Configure: the manifest config contract + the CRED-001 secret binding
  // (logical name → credential REFERENCE, never material).
  const credential = await apiCall(port(), `/api/agencies/${tenant.agencyId}/credentials`, {
    token: tenant.owner.token,
    body: { kind: 'integration_api_key', label: 'loop audience sync key', secretHandle: SECRET_HANDLE },
  });
  assert.equal(credential.status, 201, JSON.stringify(credential.body));
  const credentialId = credential.body['credentialId'] as string;
  const configure = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${tenant.workspaceId}/installs/${installId}/configure`,
    {
      token: tenant.owner.token,
      body: {
        config: { region: 'eu' },
        secretBindings: { AUDIENCE_SYNC_KEY: credentialId },
        expectedVersion: 1,
      },
    },
  );
  assert.equal(configure.status, 200, JSON.stringify(configure.body));
  assert.equal((configure.body as Record<string, unknown>)['status'], 'configured');

  const authorize = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${tenant.workspaceId}/installs/${installId}/authorize`,
    { token: tenant.owner.token, body: { expectedVersion: 2 } },
  );
  assert.equal(authorize.status, 200, JSON.stringify(authorize.body));
  assert.equal((authorize.body as Record<string, unknown>)['status'], 'authorized');

  // ---- MKT-017/018: the AI Runtime request contract + registry ----------
  const profile = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: taskProfileBody('loop-profile-1'),
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  const taskProfileId = ((profile.body as Record<string, unknown>)['taskProfile'] as Record<string, unknown>)[
    'taskProfileId'
  ] as string;

  const model = await apiCall(port(), '/api/ai/models', {
    token: await adminToken(),
    body: modelBody(),
  });
  assert.equal(model.status, 201, JSON.stringify(model.body));
  const modelRegistryId = model.body['modelRegistryId'] as string;

  // ---- THE GOAL + THE DEPLOYED LOOP (through the authority publics) -----
  const goal = await makeActiveGoal(tenant, 'golden');
  const deployment = await flow!.deployAcquisitionLoop({
    goalId: goal.goalId,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'loop-deploy-golden', causationId: null },
  });

  // The deployment composed the template through the authority publics:
  // the playbook version is PUBLISHED (with the declared extension
  // capability requirement), the workflow definition is ACTIVE, the
  // experiment is declared DRAFT with the §16 contract.
  const playbookVersions = await apiCall(port(), `/api/playbooks/${deployment.playbookId}/versions`, {
    token: tenant.owner.token,
  });
  assert.equal(playbookVersions.status, 200);
  const versionRow = (playbookVersions.body['versions'] as ReadonlyArray<Record<string, unknown>>).find(
    (row) => row['versionId'] === deployment.playbookVersionId,
  );
  assert.equal(versionRow!['status'], 'published');
  const metadata = versionRow!['deploymentMetadata'] as Record<string, unknown>;
  assert.deepEqual(metadata['requiredCapabilities'], [
    { kind: 'extension', name: 'acq-audience-sync', versionConstraint: '1.x' },
  ]);

  const definition = await apiCall(
    port(),
    `/api/workflows/${deployment.workflowId}/definitions/${deployment.workflowDefinitionId}`,
    { token: tenant.owner.token },
  );
  assert.equal(definition.status, 200);
  assert.equal(definition.body['status'], 'active');
  assert.equal(definition.body['playbookVersionId'], deployment.playbookVersionId);

  const experimentBefore = await apiCall(port(), `/api/experiments/${deployment.experimentId}`, {
    token: tenant.owner.token,
  });
  assert.equal(experimentBefore.status, 200);
  assert.equal(experimentBefore.body['status'], 'draft');
  assert.equal(experimentBefore.body['resultState'], 'undecided');
  assert.equal(
    (experimentBefore.body['primaryMetric'] as Record<string, unknown>)['name'],
    LOOP_PRIMARY_METRIC.name,
  );

  // ---- THE BOUNDED START (the five fail-closed bounds all pass) ---------
  const started = await flow!.startLoopInstance({
    deployment,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'loop-start-golden', causationId: null },
  });
  assert.equal(started.instance.status, 'running');
  assert.equal(started.experiment.status, 'running');
  const workflowInstanceId = started.instance.workflowInstanceId;

  // ---- THE AI PATH: the AI Runtime routing leg --------------------------
  const aiExecution = await flow!.createAiTaskExecution({
    deployment,
    workflowInstanceId,
    idempotencyKey: 'loop-ai-exec-1',
    actorId: tenant.owner.userId,
  });
  assert.equal(aiExecution.execution.status, 'created');
  assert.equal(aiExecution.execution.executionKind, 'ai');
  assert.equal(aiExecution.execution.runtimeClass, 'pooled-worker');
  assert.deepEqual(aiExecution.execution.taskLink, {
    kind: 'workflow-node',
    workflowInstanceId,
    nodeId: LOOP_AI_NODE,
  });

  const scoringAdapter = new LoopFakeScoringAdapter();
  const routing = await flow!.routeAiTask({
    deployment,
    taskProfileId,
    adapter: scoringAdapter,
    validator: defaultValidator,
    invocationInput: {
      prospects: [
        { prospect: 'p1', channel: 'social', score: 82 },
        { prospect: 'p2', channel: 'search', score: 91 },
        { prospect: 'p3', channel: 'social', score: 44 },
      ],
      context: { goal: 'qualified-lead acquisition loop' },
    },
    idempotencyKey: 'loop-route-ai-1',
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'loop-route-ai-golden', causationId: null },
  });
  // The cascade completed with the eligible model; the model output passed
  // the TaskProfile's output-schema validation (the authoritative routing
  // decision + cascade run are persisted by the /ai-runtime module).
  assert.equal(routing.cascadeRun.status, 'completed');
  assert.equal(routing.cascadeRun.finalModelRegistryId, modelRegistryId);
  assert.equal(routing.cascadeRun.cascadeSteps.length, 1);
  assert.equal(routing.cascadeRun.cascadeSteps[0]!.stepType, 'cheap-first');
  assert.equal(routing.cascadeRun.cascadeSteps[0]!.validatorResult, 'passed');
  assert.ok(typeof routing.selection.selectionId === 'string');
  assert.equal(scoringAdapter.invocations.length, 1, 'the cascade invoked the model exactly once');
  assert.equal(scoringAdapter.invocations[0]!.taskProfile.taskClass, 'acq.prospect_scoring');
  assert.equal(scoringAdapter.outputs[0]!['qualified_count'], AI_QUALIFIED_COUNT);

  // The AI execution reaches its terminal state through the /executions
  // transition surface (the AI leg's runtime attempt lifecycle).
  let aiVersion = aiExecution.execution.version;
  for (const to of ['queued', 'starting', 'running', 'succeeded'] as const) {
    const transition = await apiCall(port(), `/api/executions/${aiExecution.execution.executionId}/transitions`, {
      token: tenant.owner.token,
      body: {
        to,
        version: aiVersion,
        idempotencyKey: `loop-ai-exec-${to}`,
        reason: `MKT-034 E2E: the AI scoring task ${to === 'succeeded' ? 'completed with a validated output' : `is ${to}`}`,
      },
    });
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    aiVersion = (transition.body['execution'] as Record<string, unknown>)['version'] as number;
  }
  const aiFinal = await getExecution(aiExecution.execution.executionId, tenant.owner.token);
  assert.equal(aiFinal.body['status'], 'succeeded');
  assert.equal(aiFinal.body['executionKind'], 'ai');

  // ---- THE FIELD PATH: the §18 contract through the real HTTP surfaces --
  const job = await flow!.projectFieldJob({
    deployment,
    workflowInstanceId,
    actorId: tenant.owner.userId,
  });
  assert.equal(job.status, 'projected');
  assert.equal(job.workflowInstanceId, workflowInstanceId);
  assert.equal(job.nodeId, LOOP_FIELD_NODE);
  assert.equal(job.clientId, tenant.clientId);

  const agent = await makeFieldAgent('golden-agent@acqloop.test');
  const offer = await apiCall(port(), `/api/jobs/${job.jobId}/offers`, {
    token: tenant.owner.token,
    body: {
      candidateAgentId: agent.agentId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  const offerId = offer.body['offerId'] as string;

  const accepted = await apiCall(port(), `/api/jobs/${job.jobId}/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  const visit = await apiCall(port(), `/api/jobs/${job.jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'Accra Retail Cluster 7' },
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  const visitId = visit.body['visitId'] as string;

  const startedVisit = await apiCall(port(), `/api/jobs/${job.jobId}/visits/${visitId}/start`, {
    token: agent.token,
    body: {},
  });
  assert.equal(startedVisit.status, 200);

  // Field evidence capture (§18): the accepted agent records observations
  // DURING execution, with server-derived scope + provenance.
  const captured = await apiCall(port(), `/api/jobs/${job.jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'C',
      observedAt: new Date().toISOString(),
      sourceRef: 'cluster-7-feedback-form',
      content: {
        venue: 'Accra Retail Cluster 7',
        footfall_estimate: 240,
        interested_contacts: 3,
        notes: 'Three contacts left details and asked for the synced audience follow-up.',
      },
    },
  });
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  const fieldEvidenceId = captured.body['evidenceId'] as string;

  // The captured evidence is an /evidence record of the job's client with
  // field-agent provenance (EVID-AC-01..03 field subset) — UNDER THE SAME
  // CLIENT as the loop's Goal (the shared lifecycle's evidence scope).
  const fieldEvidence = await apiCall(port(), `/api/evidence/${fieldEvidenceId}`, { token: tenant.owner.token });
  assert.equal(fieldEvidence.status, 200);
  assert.equal(fieldEvidence.body['class'], 'observation');
  assert.equal(fieldEvidence.body['clientId'], tenant.clientId);
  assert.equal((fieldEvidence.body['provenance'] as Record<string, unknown>)['recordedVia'], 'field-agent');

  // Structured visit outcome (§18): frozen vocabulary + explicit follow-up
  // declaration + REQUIRED evidence reference.
  const completed = await apiCall(port(), `/api/jobs/${job.jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: 'Visit achieved its purpose: 3 qualified contacts recorded.',
      observations: {
        contacts_collected: 3,
        collateral_left: 12,
        sentiment: 'positive',
      },
      evidenceRef: fieldEvidenceId,
    },
  });
  assert.equal(completed.status, 201, JSON.stringify(completed.body));
  assert.equal((completed.body['visit'] as Record<string, unknown>)['status'], 'completed');

  // Job outcome submission (§18): the accepted agent reports with REQUIRED
  // evidence.
  const outcome = await apiCall(port(), `/api/jobs/${job.jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'succeeded', evidenceRef: fieldEvidenceId },
  });
  assert.equal(outcome.status, 201, JSON.stringify(outcome.body));
  assert.equal((outcome.body['job'] as Record<string, unknown>)['status'], 'outcome_submitted');

  // ---- THE EXTENSION PATH: §19 invocation + pooled runtime --------------
  const extExecution = await flow!.createExtensionExecution({
    deployment,
    workflowInstanceId,
    idempotencyKey: 'loop-ext-exec-1',
    actorId: tenant.owner.userId,
  });
  assert.equal(extExecution.execution.status, 'created');
  assert.equal(extExecution.execution.executionKind, 'extension');
  assert.equal(extExecution.execution.runtimeClass, 'pooled-worker');
  assert.deepEqual(extExecution.execution.taskLink, {
    kind: 'workflow-node',
    workflowInstanceId,
    nodeId: LOOP_EXTENSION_NODE,
  });

  // THE SHARED LIFECYCLE assertion: all three paths carry the SAME workflow
  // instance (E2E-AC-01 "a shared Goal/Workflow/Evidence lifecycle").
  assert.equal(
    aiExecution.execution.taskLink.workflowInstanceId,
    extExecution.execution.taskLink.workflowInstanceId,
  );
  assert.equal(job.workflowInstanceId, extExecution.execution.taskLink.workflowInstanceId);

  // The §19 invocation context through the /extensions public: scope
  // SERVER-DERIVED from the execution's canonical owner (never caller
  // input), the granted capability set bounded by the manifest, the policy
  // posture an explicit recorded allow, recorded in the append-only ledger.
  const context = await flow!.beginExtensionAction({
    executionId: extExecution.execution.executionId,
    extensionId,
    requestedCapabilities: ['sync-audience-segment'],
    invocationInput: { segmentId: 'seg-golden-1', note: 'the loop cohort sync' },
    correlation: { correlationId: 'loop-invoke-golden', causationId: null },
  });
  assert.equal(context.scope.kind, 'extension-invocation');
  assert.equal(context.scope.agencyId, tenant.agencyId);
  assert.equal(context.scope.clientId, tenant.clientId);
  assert.equal(context.scope.workspaceId, tenant.workspaceId);
  assert.deepEqual(context.grantedCapabilities, [
    { category: 'execution-action', name: 'sync-audience-segment' },
  ]);
  assert.deepEqual(context.grantedDataScopes, ['client:read']);
  assert.equal(context.installId, installId);
  assert.ok(typeof context.policyDecisionId === 'string' && context.policyDecisionId.length > 0);
  assert.ok(Date.parse(context.expiresAt) > Date.parse(context.issuedAt));
  assert.equal(context.input['segmentId'], 'seg-golden-1');
  // The context carries NO credential-shaped field (§5/CRED-001).
  for (const forbidden of ['secret', 'secretHandle', 'material', 'token', 'apiKey']) {
    assert.ok(!JSON.stringify(context).includes(`"${forbidden}"`), `the context must not carry '${forbidden}'`);
  }

  // The invocation landed in the AUTHORITATIVE append-only ledger (Observe)
  // — readable through the authority's HTTP surface.
  const ledger = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/extension-invocations`, {
    token: tenant.owner.token,
  });
  assert.equal(ledger.status, 200);
  const ledgerRows = ledger.body['invocations'] as ReadonlyArray<Record<string, unknown>>;
  const ledgerRow = ledgerRows.find((row) => row['invocationId'] === context.invocationId);
  assert.ok(ledgerRow !== undefined, 'the invocation is in the append-only ledger');
  assert.equal(ledgerRow!['policyOutcome'], 'allow');
  assert.equal(ledgerRow!['executionId'], extExecution.execution.executionId);
  assert.equal(ledgerRow!['installId'], installId);

  // The extension execution rides the POOLED runtime (the MKT-011 path a
  // pooled-worker-class extension action executes under): dispatch through
  // the real HTTP route, drained by a REAL worker subprocess.
  const dispatch = await apiCall(port(), `/api/executions/${extExecution.execution.executionId}/dispatch`, {
    token: tenant.owner.token,
    body: {
      taskKind: 'data.transform',
      input: {
        records: [
          { segment: 'seg-golden-1', member: 'm1', synced: true },
          { segment: 'seg-golden-1', member: 'm2', synced: true },
          { segment: 'seg-golden-1', member: 'm3', synced: true },
        ],
        sortBy: 'member',
      },
      idempotencyKey: 'loop-ext-dispatch-1',
    },
  });
  assert.equal(dispatch.status, 201, JSON.stringify(dispatch.body));

  const worker = await spawnWorker(stack!.env);
  assert.equal(await worker.exitCode(), 0, 'drain worker exits cleanly');

  const extFinal = await waitTerminalExecution(extExecution.execution.executionId, tenant.owner.token);
  assert.equal(extFinal['status'], 'succeeded');
  assert.equal(extFinal['executionKind'], 'extension');

  // The content-addressed artifact exists and matches its digest — the
  // extension leg's durable output evidence.
  const dispatchRead = await apiCall(
    port(),
    `/api/executions/${extExecution.execution.executionId}/dispatch`,
    { token: tenant.owner.token },
  );
  const outputRef = (dispatchRead.body['dispatch'] as Record<string, unknown>)['outputRef'] as string;
  assert.ok(typeof outputRef === 'string' && outputRef.length === 64);
  const artifactPath = path.join(stack!.env.objectStoreDir, outputRef.slice(0, 2), outputRef);
  const artifactBytes = fs.readFileSync(artifactPath);
  assert.equal(createHash('sha256').update(artifactBytes).digest('hex'), outputRef);

  // ---- EVIDENCE for all three paths + the loop outcome (shared client) --
  const aiEvidence = await flow!.recordLoopEvidence({
    deployment,
    sourceRef: `ai:${routing.selection.selectionId}`,
    evidenceClass: 'observation',
    quality: 'C',
    observedAtIso: new Date().toISOString(),
    content: {
      leg: 'ai',
      workflow_instance: workflowInstanceId,
      node: LOOP_AI_NODE,
      selection_id: routing.selection.selectionId,
      cascade_run_id: routing.cascadeRun.cascadeRunId,
      qualified_count: AI_QUALIFIED_COUNT,
      top_prospect: AI_TOP_PROSPECT,
    },
    contentRef: null,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'loop-evidence-ai', causationId: null },
  });
  assert.equal(aiEvidence.class, 'observation');
  assert.equal(aiEvidence.quality, 'C');
  assert.equal(aiEvidence.clientId, tenant.clientId);
  assert.equal(aiEvidence.provenance.recordedVia, 'worker:acquisition-loop');

  const extensionEvidence = await flow!.recordLoopEvidence({
    deployment,
    sourceRef: `extension:${context.invocationId}`,
    evidenceClass: 'observation',
    quality: 'C',
    observedAtIso: new Date().toISOString(),
    content: {
      leg: 'extension',
      workflow_instance: workflowInstanceId,
      node: LOOP_EXTENSION_NODE,
      invocation_id: context.invocationId,
      policy_decision_id: context.policyDecisionId,
      synced_count: 3,
    },
    contentRef: outputRef,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'loop-evidence-ext', causationId: null },
  });
  assert.equal(extensionEvidence.class, 'observation');
  assert.equal(extensionEvidence.provenance.recordedVia, 'worker:acquisition-loop');

  const outcomeEvidence = await flow!.recordLoopEvidence({
    deployment,
    sourceRef: `loop:${workflowInstanceId}`,
    evidenceClass: 'source_fact',
    quality: 'B',
    observedAtIso: new Date().toISOString(),
    content: {
      loop_instance: workflowInstanceId,
      ai_selection_id: routing.selection.selectionId,
      extension_invocation_id: context.invocationId,
      extension_artifact_ref: outputRef,
      field_visit_result: 'succeeded',
      qualified_leads: 3,
      total_cost_usd: 420,
    },
    contentRef: outputRef,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'loop-evidence-outcome', causationId: null },
  });
  assert.equal(outcomeEvidence.class, 'source_fact');
  assert.equal(outcomeEvidence.quality, 'B');

  // ---- METRICS with evidence provenance + the measurement ---------------
  await appendMetric(tenant, LOOP_PRIMARY_METRIC.name, 3, 'count', outcomeEvidence.evidenceId);
  await appendMetric(tenant, LOOP_GUARDRAIL_COST.name, 420, 'USD', outcomeEvidence.evidenceId);

  const metricList = await apiCall(port(), `/api/clients/${tenant.clientId}/metrics`, {
    token: tenant.owner.token,
  });
  assert.equal(metricList.status, 200);
  const observations = metricList.body['observations'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(observations.length, 2);
  for (const observation of observations) {
    assert.equal((observation['provenance'] as Record<string, unknown>)['recordedVia'], 'api');
    assert.equal(observation['evidenceRef'], outcomeEvidence.evidenceId);
  }

  const measurement = await flow!.evaluateLoopGuardrails(tenant.clientId);
  assert.equal(measurement.evaluation.breached, false);
  assert.equal(measurement.evaluation.primaryMetricTotal, 3);
  assert.equal(measurement.evaluation.guardrails[0]!.totalValue, 420);
  assert.equal(measurement.evaluation.guardrails[0]!.breached, false);

  // ---- THE §16 CONCLUSION: decision citing the same-Client evidence -----
  const concluded = await flow!.concludeLoopExperiment({
    deployment,
    conclusion: {
      resultState: 'observation',
      resultingDecision:
        'Extend: the bounded loop produced 3 qualified leads through the AI + field + extension motion within the 500 USD cost guardrail — proceed to the next bounded iteration.',
      uncertaintyInterval: { lower: 1, upper: 5, level: 0.9 },
      assumptions: ['single-arm loop window comparison across the three execution paths'],
      sampleLimitations: ['one loop instance — a prove-it-first sample, not a powered estimate'],
      confounders: ['seasonal footfall variation', 'concurrent brand campaign'],
      evidenceRefs: [fieldEvidenceId, aiEvidence.evidenceId, extensionEvidence.evidenceId, outcomeEvidence.evidenceId],
    },
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'loop-conclude-golden', causationId: null },
  });
  assert.equal(concluded.status, 'concluded');
  assert.equal(concluded.resultState, 'observation');
  assert.ok(concluded.resultingDecision !== null && concluded.resultingDecision.includes('Extend'));
  assert.equal(concluded.concludedAt !== null, true);

  // The append-only transition history preserved the conclusion verbatim.
  const history = await apiCall(port(), `/api/experiments/${deployment.experimentId}/transitions`, {
    token: tenant.owner.token,
  });
  const transitions = history.body['transitions'] as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(transitions.map((row) => row['transition']), ['mark_ready', 'start', 'begin_analysis', 'conclude']);
  const conclusionRow = transitions[transitions.length - 1]!;
  const conclusion = conclusionRow['conclusion'] as Record<string, unknown>;
  assert.deepEqual(conclusion['evidenceRefs'], [
    fieldEvidenceId,
    aiEvidence.evidenceId,
    extensionEvidence.evidenceId,
    outcomeEvidence.evidenceId,
  ]);
  assert.deepEqual(conclusion['uncertainty'], { kind: 'interval', lower: 1, upper: 5, level: 0.9 });

  // ---- THE §17 LEARNING: citing the evidence + the CONCLUDED experiment -
  const learning = await flow!.recordLoopLearning({
    deployment,
    learning: {
      statement:
        'A bounded acquisition loop that combines AI-scored outreach, one field visit and one extension audience-sync under one workflow lifecycle produced qualified leads within the declared cost guardrail for this client cohort.',
      applicability: { motion: 'acquisition', stage: 'prove-it-first', region: 'accra' },
      evidenceRefs: [
        fieldEvidenceId,
        aiEvidence.evidenceId,
        extensionEvidence.evidenceId,
        outcomeEvidence.evidenceId,
      ],
      experimentRefs: [deployment.experimentId],
      confidence: 0.8,
    },
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'loop-learn-golden', causationId: null },
  });
  assert.equal(learning.status, 'active');
  assert.equal(learning.clientId, tenant.clientId);
  assert.equal(learning.workspaceId, tenant.workspaceId);
  assert.deepEqual(learning.experimentRefs, [deployment.experimentId]);
  assert.equal(learning.provenance.recordedVia, 'worker:acquisition-loop');

  // ---- THE SHARED LIFECYCLE closes: the instance reaches its terminal ---
  const instanceRead = await apiCall(
    port(),
    `/api/workflows/${deployment.workflowId}/instances/${workflowInstanceId}`,
    { token: tenant.owner.token },
  );
  assert.equal(instanceRead.status, 200);
  const instanceTerminal = await apiCall(
    port(),
    `/api/workflows/${deployment.workflowId}/instances/${workflowInstanceId}/transitions`,
    {
      token: tenant.owner.token,
      body: {
        to: 'succeeded',
        version: instanceRead.body['version'] as number,
        idempotencyKey: 'loop-golden-instance-succeeded',
        reason: 'loop instance concluded through the experiment authority after all three legs settled',
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

  // WHAT HAPPENED: the loop Goal + the loop workflow with its terminal
  // instance (all three execution legs' shared carrier).
  const whatHappened = roomBody['whatHappened'] as Record<string, unknown>;
  const goals = whatHappened['goals'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(goals.length, 1);
  assert.equal(goals[0]!['goalId'], deployment.goalId);
  assert.equal(goals[0]!['status'], 'active');
  assert.equal(goals[0]!['workspaceId'], tenant.workspaceId);
  assert.equal(
    (goals[0]!['successCriteria'] as ReadonlyArray<Record<string, unknown>>)[0]!['metric'],
    LOOP_PRIMARY_METRIC.name,
  );
  const workflows = whatHappened['workflows'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]!['workflowId'], deployment.workflowId);
  const instanceCounts = workflows[0]!['instanceCounts'] as Record<string, number>;
  assert.equal(instanceCounts['succeeded'], 1);
  const roomInstances = workflows[0]!['instances'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(roomInstances[0]!['workflowInstanceId'], workflowInstanceId);
  assert.equal(roomInstances[0]!['status'], 'succeeded');

  // WHY: the loop Learning (the §17 hop) with its applicability + refs.
  const why = (roomBody['why'] as Record<string, unknown>)['learnings'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(why.length, 1);
  assert.equal(why[0]!['learningId'], learning.learningId);
  assert.equal(why[0]!['status'], 'active');
  assert.deepEqual(why[0]!['experimentRefs'], [deployment.experimentId]);
  assert.deepEqual((roomBody['why'] as Record<string, unknown>)['learningStatusCounts'], {
    active: 1,
    superseded: 0,
    contradicted: 0,
    retired: 0,
  });

  // EVIDENCE QUALITY: the loop's evidence chain (3 observations C + 1
  // source_fact B).
  const quality = roomBody['evidenceQuality'] as Record<string, unknown>;
  assert.equal(quality['totalRecords'], 4);
  const byClass = quality['byClass'] as ReadonlyArray<Record<string, unknown>>;
  const observationPosture = byClass.find((entry) => entry['class'] === 'observation')!;
  assert.deepEqual(observationPosture['gradeCounts'], { A: 0, B: 0, C: 3, D: 0, E: 0, F: 0 });
  const sourceFactPosture = byClass.find((entry) => entry['class'] === 'source_fact')!;
  assert.deepEqual(sourceFactPosture['gradeCounts'], { A: 0, B: 1, C: 0, D: 0, E: 0, F: 0 });

  // EXPERIMENTS: the loop experiment with the RESULTING DECISION surfaced
  // verbatim (never re-derived).
  const experimentsView = roomBody['experiments'] as Record<string, unknown>;
  const experiments = experimentsView['experiments'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(experiments.length, 1);
  const concludedView = experiments.find((entry) => entry['experimentId'] === deployment.experimentId)!;
  assert.equal(concludedView['status'], 'concluded');
  assert.equal(concludedView['designType'], 'quasi_experimental');
  assert.equal(concludedView['analysisMethod'], 'loop_window_comparison');
  assert.equal(concludedView['primaryMetricName'], LOOP_PRIMARY_METRIC.name);
  assert.equal(concludedView['resultState'], 'observation');
  assert.ok(String(concludedView['resultingDecision']).includes('Extend'));

  // RECOMMENDATIONS: exactly the applicable learning + the declared
  // experiment decision — no invented lift.
  const recommendations = roomBody['recommendations'] as Record<string, unknown>;
  assert.equal(recommendations['basis'], 'applicable_learnings_and_declared_experiment_decisions');
  const items = recommendations['items'] as ReadonlyArray<Record<string, unknown>>;
  const learningItems = items.filter((item) => item['kind'] === 'applicable_learning');
  const decisionItems = items.filter((item) => item['kind'] === 'experiment_decision');
  assert.equal(learningItems.length, 1);
  assert.equal(learningItems[0]!['learningId'], learning.learningId);
  assert.equal(decisionItems.length, 1);
  assert.equal(decisionItems[0]!['experimentId'], deployment.experimentId);
  assert.ok(String(decisionItems[0]!['resultingDecision']).includes('Extend'));
  for (const forbidden of ['lift', 'causalLift', 'incrementalEffect', 'uplift']) {
    assert.ok(!(forbidden in decisionItems[0]!), `the recommendation vocabulary has no '${forbidden}' field`);
  }

  // APPROVALS: nothing pending — the experiment concluded and the instance
  // reached its terminal state.
  const approvals = (roomBody['approvals'] as Record<string, unknown>)['items'] as readonly unknown[];
  assert.equal(approvals.length, 0);

  // ---- THE DERIVED LOOP STATUS re-reads the full chain ------------------
  const status = await flow!.getLoopStatus(deployment);
  assert.equal(status.goalStatus, 'active');
  assert.equal(status.playbookVersionStatus, 'published');
  assert.equal(status.workflowDefinitionStatus, 'active');
  assert.equal(status.experimentStatus, 'concluded');
  assert.equal(status.experimentResultState, 'observation');
  assert.ok(status.resultingDecision !== null && status.resultingDecision.includes('Extend'));
  assert.equal(status.instances.length, 1);
  assert.equal(status.instances[0]!.status, 'succeeded');
  assert.equal(status.instances[0]!.terminal, true);
  assert.equal(status.liveInstanceCount, 0);
  assert.equal(status.learnings.length, 1);
  assert.equal(status.learnings[0]!.learningId, learning.learningId);
  assert.equal(status.learnings[0]!.status, 'active');
  assert.equal(status.measurement.primaryMetricTotal, 3);
  assert.equal(status.measurement.breached, false);

  shared = {
    tenant,
    extensionId,
    installId,
    deployment,
    workflowId: deployment.workflowId,
    workflowInstanceId,
    goldenExtensionExecutionId: extExecution.execution.executionId,
    extensionOutputRef: outputRef,
    jobId: job.jobId,
    fieldEvidenceId,
    aiEvidenceId: aiEvidence.evidenceId,
    extensionEvidenceId: extensionEvidence.evidenceId,
    outcomeEvidenceId: outcomeEvidence.evidenceId,
    experimentId: deployment.experimentId,
    learningId: learning.learningId,
  };
});

// ---------------------------------------------------------------------------
// NEGATIVE — PERMISSION BYPASS: a foreign agency cannot install the
// reviewed version (the approval is agency-scoped; the gate is INSIDE the
// authority) — 403 POLICY_DENIED with ZERO install rows
// ---------------------------------------------------------------------------

test('extension authority: a foreign agency install is denied AT THE AUTHORITY (403 POLICY_DENIED) with zero install rows', async () => {
  const { extensionId } = state();
  const foreign = await makeTenant('foreign-install');

  const denied = await apiCall(port(), `/api/extension-portal/workspaces/${foreign.workspaceId}/installs`, {
    token: foreign.owner.token,
    body: { extensionId, grantedScopes: ['client:read'], idempotencyKey: 'loop-foreign-install-1' },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(errorCode(denied.body), 'POLICY_DENIED');

  // ZERO partial writes: no install row exists for the foreign workspace.
  const installs = await stack!.pg.pool.query(
    'SELECT install_id FROM extension_installs WHERE workspace_id = $1',
    [foreign.workspaceId],
  );
  assert.equal(installs.rows.length, 0);
});

// ---------------------------------------------------------------------------
// NEGATIVE — FORGED LIFECYCLE + UNAUTHORIZED INSTALL: installed→authorized
// is the authority 409; an invocation against a configured-but-not-
// authorized install is the authority 409 with ZERO ledger rows and the
// execution left non-terminal (reconcilable state)
// ---------------------------------------------------------------------------

test('extension authority: forged install transitions are 409 and an unauthorized install blocks invocation with zero ledger rows', async () => {
  const { tenant, extensionId } = state();

  // A second workspace of the SAME client (the agency-scoped approval
  // covers every workspace of the agency).
  const workspace2 = await apiCall(port(), `/api/clients/${tenant.clientId}/workspaces`, {
    token: tenant.owner.token,
    body: { name: 'Loop Workspace A2' },
  });
  assert.equal(workspace2.status, 201);
  const workspace2Id = workspace2.body['workspaceId'] as string;

  const install = await apiCall(port(), `/api/extension-portal/workspaces/${workspace2Id}/installs`, {
    token: tenant.owner.token,
    body: { extensionId, grantedScopes: ['client:read'], idempotencyKey: 'loop-install-a2-1' },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const installA2Id = (install.body as Record<string, unknown>)['install'] as Record<string, unknown>;
  const installId = installA2Id['installId'] as string;

  // FORGED TRANSITION: installed → authorized is NOT a frozen edge (the
  // install must configure first): the AUTHORITY's transition guard
  // rejects with 409.
  const earlyAuthorize = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspace2Id}/installs/${installId}/authorize`,
    { token: tenant.owner.token, body: { expectedVersion: 1 } },
  );
  assert.equal(earlyAuthorize.status, 409, JSON.stringify(earlyAuthorize.body));

  // Configure WITHOUT authorizing: the install stays 'configured'.
  const credential = await apiCall(port(), `/api/agencies/${tenant.agencyId}/credentials`, {
    token: tenant.owner.token,
    body: { kind: 'integration_api_key', label: 'loop a2 key', secretHandle: SECRET_HANDLE },
  });
  assert.equal(credential.status, 201);
  const configure = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspace2Id}/installs/${installId}/configure`,
    {
      token: tenant.owner.token,
      body: {
        config: { region: 'eu' },
        secretBindings: { AUDIENCE_SYNC_KEY: credential.body['credentialId'] as string },
        expectedVersion: 1,
      },
    },
  );
  assert.equal(configure.status, 200);
  assert.equal((configure.body as Record<string, unknown>)['status'], 'configured');

  // A live extension-kind execution in workspace A2 (the §7 external-request
  // linkage — the invocation target).
  const executionId = await makeExtensionExecution(workspace2Id, tenant.owner.token, 'loop-a2-unauthorized-1');

  // The invocation against the CONFIGURED-but-not-AUTHORIZED install fails
  // AT THE AUTHORITY (409 — invocation requires an authorized install).
  const invocation = await apiCall(port(), `/api/executions/${executionId}/extension-invocations`, {
    token: tenant.owner.token,
    body: {
      extensionId,
      requestedCapabilities: ['sync-audience-segment'],
      input: { segmentId: 'seg-a2-1' },
    },
  });
  assert.equal(invocation.status, 409, JSON.stringify(invocation.body));
  assert.match(JSON.stringify(invocation.body), /invocation requires an authorized install/);

  // ZERO partial writes: no invocation ledger row for the execution.
  const ledger = await stack!.pg.pool.query(
    'SELECT invocation_id FROM extension_invocations WHERE execution_id = $1',
    [executionId],
  );
  assert.equal(ledger.rows.length, 0);

  // Reconcilable state: the execution is still non-terminal (created) —
  // the failed hop left nothing half-done.
  const executionRead = await getExecution(executionId, tenant.owner.token);
  assert.equal(executionRead.status, 200);
  assert.equal(executionRead.body['status'], 'created');
});

// ---------------------------------------------------------------------------
// NEGATIVE — INVOCATION GUARDS: undeclared capability 422; authority-shaped
// input 422; a foreign-workspace caller is the uniform 404; a TERMINAL
// execution refuses invocation (409)
// ---------------------------------------------------------------------------

test('extension authority: invocation input guards, foreign callers and dead executions all fail closed', async () => {
  const { tenant, extensionId, goldenExtensionExecutionId } = state();

  // A live extension-kind execution in the golden workspace.
  const executionId = await makeExtensionExecution(tenant.workspaceId, tenant.owner.token, 'loop-guards-1');

  // UNDECLARED CAPABILITY: the manifest guard rejects (422 — the frozen
  // capability set is closed).
  const undeclared = await apiCall(port(), `/api/executions/${executionId}/extension-invocations`, {
    token: tenant.owner.token,
    body: { extensionId, requestedCapabilities: ['not-a-declared-capability'], input: { segmentId: 'seg-x' } },
  });
  assert.equal(undeclared.status, 422, JSON.stringify(undeclared.body));

  // AUTHORITY-SHAPED INPUT KEY: the DTO guard rejects scope-shaped keys
  // (identity/scope/policy are server-derived — an extension can never
  // assert them).
  const smuggled = await apiCall(port(), `/api/executions/${executionId}/extension-invocations`, {
    token: tenant.owner.token,
    body: {
      extensionId,
      requestedCapabilities: ['sync-audience-segment'],
      input: { segmentId: 'seg-x', scope: { agencyId: '00000000-0000-0000-0000-000000000001' } },
    },
  });
  assert.equal(smuggled.status, 422, JSON.stringify(smuggled.body));

  // FOREIGN WORKSPACE CALLER: a foreign agency's owner cannot even resolve
  // the execution — the uniform 404 (no cross-tenant oracle).
  const foreign = await makeTenant('foreign-invoke');
  const foreignCall = await apiCall(port(), `/api/executions/${executionId}/extension-invocations`, {
    token: foreign.owner.token,
    body: { extensionId, requestedCapabilities: ['sync-audience-segment'], input: { segmentId: 'seg-x' } },
  });
  assert.equal(foreignCall.status, 404, JSON.stringify(foreignCall.body));

  // TERMINAL EXECUTION: the golden extension execution is SUCCEEDED — a
  // dead execution cannot mint invocation contexts (409).
  const deadExecution = await apiCall(
    port(),
    `/api/executions/${goldenExtensionExecutionId}/extension-invocations`,
    {
      token: tenant.owner.token,
      body: { extensionId, requestedCapabilities: ['sync-audience-segment'], input: { segmentId: 'seg-x' } },
    },
  );
  assert.equal(deadExecution.status, 409, JSON.stringify(deadExecution.body));
  assert.match(JSON.stringify(deadExecution.body), /invocation requires a live execution/);

  // No ledger rows were minted by any failed probe.
  const ledger = await stack!.pg.pool.query(
    'SELECT invocation_id FROM extension_invocations WHERE execution_id = $1',
    [executionId],
  );
  assert.equal(ledger.rows.length, 0);
});

// ---------------------------------------------------------------------------
// NEGATIVE — FIELD TENANT ISOLATION: a foreign tenant reading the loop's
// §18 job over HTTP is the uniform 404
// ---------------------------------------------------------------------------

test('field authority: a foreign tenant reading the loop job is the uniform 404', async () => {
  const { jobId } = state();
  const foreign = await makeTenant('foreign-job');

  const foreignRead = await apiCall(port(), `/api/jobs/${jobId}`, { token: foreign.owner.token });
  assert.equal(foreignRead.status, 404, JSON.stringify(foreignRead.body));
});

// ---------------------------------------------------------------------------
// NEGATIVE — AI HOP FENCE: routing with a FOREIGN workspace's TaskProfile
// is the uniform NotFoundError at the composition pre-fence
// ---------------------------------------------------------------------------

test('AI runtime authority: routing with a foreign workspace TaskProfile is the uniform NotFoundError', async () => {
  const { deployment, tenant } = state();

  // A TaskProfile in a FOREIGN workspace (created through the real
  // /ai-runtime HTTP surface of the foreign tenant).
  const foreign = await makeTenant('foreign-profile');
  const foreignProfile = await apiCall(port(), `/api/workspaces/${foreign.workspaceId}/ai/task-profiles`, {
    token: foreign.owner.token,
    body: taskProfileBody('loop-foreign-profile-1'),
  });
  assert.equal(foreignProfile.status, 201, JSON.stringify(foreignProfile.body));
  const foreignProfileId = ((foreignProfile.body as Record<string, unknown>)['taskProfile'] as Record<string, unknown>)[
    'taskProfileId'
  ] as string;

  // The golden loop cannot route against the foreign profile: uniform 404
  // (a foreign profile id is not a traversal oracle — the composition
  // pre-fence fires BEFORE the routing write).
  await assert.rejects(
    flow!.routeAiTask({
      deployment,
      taskProfileId: foreignProfileId,
      adapter: new LoopFakeScoringAdapter(),
      validator: defaultValidator,
      invocationInput: { prospects: [] },
      idempotencyKey: 'loop-route-foreign-1',
      actorId: tenant.owner.userId,
      correlation: { correlationId: 'loop-route-foreign', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NotFoundError, `expected NotFoundError, got ${String(error)}`);
      assert.match(error.message, /task-profile/);
      return true;
    },
  );

  // And an UNKNOWN profile id is the SAME uniform 404.
  await assert.rejects(
    flow!.routeAiTask({
      deployment,
      taskProfileId: '00000000-0000-0000-0000-000000000000',
      adapter: new LoopFakeScoringAdapter(),
      validator: defaultValidator,
      invocationInput: { prospects: [] },
      idempotencyKey: 'loop-route-unknown-1',
      actorId: tenant.owner.userId,
      correlation: { correlationId: 'loop-route-unknown', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// NEGATIVE — LOOP FENCES: cross-Client evidence citation is the uniform 404
// (experiment stays RUNNING, transition history intact — fail-closed BEFORE
// the write); the live-instance cap blocks a concurrent second start; the
// Learning fences (non-concluded experiment + foreign evidence)
// ---------------------------------------------------------------------------

test('loop fences: cross-Client citation 404 leaves the experiment running; the live cap blocks a second start; Learning fences reject bad references with zero rows', async () => {
  // A second loop deployment for a fresh tenant (the fence tenant).
  const fence = await makeDeployedLoop('fence');
  const started = await flow!.startLoopInstance({
    deployment: fence.deployment,
    actorId: fence.tenant.owner.userId,
    correlation: { correlationId: 'loop-fence-start-1', causationId: null },
  });
  assert.equal(started.instance.status, 'running');

  // A foreign tenant appends its own evidence (same-Client rule target).
  const foreign = await makeTenant('fence-foreign');
  const foreignEvidence = await apiCall(port(), `/api/clients/${foreign.clientId}/evidence`, {
    token: foreign.owner.token,
    body: {
      class: 'observation',
      sourceSystem: 'acquisition-loop',
      sourceRef: 'foreign-evidence',
      observedAt: new Date().toISOString(),
      content: { note: 'foreign tenant evidence' },
      quality: 'C',
    },
  });
  assert.equal(foreignEvidence.status, 201);
  const foreignEvidenceId = foreignEvidence.body['evidenceId'] as string;

  // CROSS-CLIENT CITATION: the fence loop's conclusion citing the foreign
  // evidence is rejected by the /experiments authority with a uniform 404.
  await assert.rejects(
    flow!.concludeLoopExperiment({
      deployment: fence.deployment,
      conclusion: {
        resultState: 'observation',
        resultingDecision: 'must never land',
        uncertaintyInterval: { lower: 0, upper: 1, level: 0.9 },
        assumptions: [],
        sampleLimitations: [],
        confounders: [],
        evidenceRefs: [foreignEvidenceId],
      },
      actorId: fence.tenant.owner.userId,
      correlation: { correlationId: 'loop-fence-conclude-foreign', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NotFoundError, `expected NotFoundError, got ${String(error)}`);
      assert.match(error.message, /evidence/);
      return true;
    },
  );

  // RECONCILABLE STATE: the experiment was NOT moved to analyzing (the
  // pre-fence fired BEFORE begin_analysis) — still running, still
  // undecided, transition history exactly [mark_ready, start].
  const experimentRead = await apiCall(port(), `/api/experiments/${fence.deployment.experimentId}`, {
    token: fence.tenant.owner.token,
  });
  assert.equal(experimentRead.body['status'], 'running');
  assert.equal(experimentRead.body['resultState'], 'undecided');
  const history = await apiCall(port(), `/api/experiments/${fence.deployment.experimentId}/transitions`, {
    token: fence.tenant.owner.token,
  });
  assert.deepEqual(
    (history.body['transitions'] as ReadonlyArray<Record<string, unknown>>).map((row) => row['transition']),
    ['mark_ready', 'start'],
  );

  // THE LIVE-INSTANCE CAP: a concurrent second start of the same loop is
  // blocked (fail-closed BEFORE any write).
  await assert.rejects(
    flow!.startLoopInstance({
      deployment: fence.deployment,
      actorId: fence.tenant.owner.userId,
      correlation: { correlationId: 'loop-fence-start-2', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /1 live \(non-terminal\) instances/);
      return true;
    },
  );

  // LEARNING FENCE — non-concluded experiment: an outcome reference
  // requires a declared outcome (the fence experiment is running).
  await assert.rejects(
    flow!.recordLoopLearning({
      deployment: fence.deployment,
      learning: {
        statement: 'must never land (running experiment reference)',
        applicability: { motion: 'acquisition' },
        evidenceRefs: [],
        experimentRefs: [fence.deployment.experimentId],
        confidence: 0.5,
      },
      actorId: fence.tenant.owner.userId,
      correlation: { correlationId: 'loop-fence-learn-running', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError, `expected InvalidRequestError, got ${String(error)}`);
      assert.match(error.message, /CONCLUDED experiment outcomes/);
      return true;
    },
  );

  // LEARNING FENCE — foreign evidence: the uniform 404 (same-Client rule).
  await assert.rejects(
    flow!.recordLoopLearning({
      deployment: fence.deployment,
      learning: {
        statement: 'must never land (foreign evidence reference)',
        applicability: { motion: 'acquisition' },
        evidenceRefs: [foreignEvidenceId],
        experimentRefs: [],
        confidence: 0.5,
      },
      actorId: fence.tenant.owner.userId,
      correlation: { correlationId: 'loop-fence-learn-foreign', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.match(error.message, /evidence/);
      return true;
    },
  );

  // ZERO partial writes: the fence client has NO learning rows.
  const learnings = await stack!.pg.pool.query(
    'SELECT learning_id FROM learnings WHERE client_id = $1',
    [fence.tenant.clientId],
  );
  assert.equal(learnings.rows.length, 0);

  // The golden loop's learning is untouched by the fence probes (the
  // golden client's learning ledger still holds exactly the golden row).
  const goldenLearnings = await stack!.pg.pool.query(
    'SELECT learning_id FROM learnings WHERE client_id = $1',
    [state().tenant.clientId],
  );
  assert.equal(goldenLearnings.rows.length, 1);
  assert.equal(goldenLearnings.rows[0]!.learning_id, state().learningId);
});
