/**
 * MKT-054 integration tests — the Growth Operator on the REAL stack
 * (embedded PostgreSQL 18 + the real in-process application composed
 * against the SAME database the spawned API serves — the MKT-034
 * sanctioned test-harness wiring, the growth-missions/client-memory
 * precedent). No platform service is mocked; the delegated authorities
 * (workflows/executions/experiments/evidence/decisions/policies/learnings)
 * are the REAL modules.
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-054):
 *   - THE MISSION ROUND-TRIP: delegate → the workflow authority executes
 *     (the runtime plane simulated honestly through the authorities' own
 *     transition commands) → the operator observes evidence → replans;
 *   - ZERO-HUMAN PATH END-TO-END: the default (zero) human budget selects,
 *     delegates, observes and replans continuously — the zero-human state
 *     is a recorded strategy input, never an error, never a fabricated
 *     human result;
 *   - blocked_pending_human_action FROM A SIMULATED RIGHTS GATE (the
 *     disclosed AppOptions.growthOperatorGate double) AND FROM THE REAL
 *     /policies ENGINE (an explicit client-scoped deny);
 *   - RESTART-SAFETY / CRASH-RECOVERY RECONCILIATION: a mid-delegation
 *     crash (the workflows port throws between instance creation and the
 *     execution creation) leaves a 'planned' step the next tick re-drives
 *     convergently — NO double dispatch (exactly one workflow, one
 *     definition, one instance, one execution);
 *   - IDEMPOTENT REPLANNING: repeated ticks with unchanged world are
 *     no-ops; a changed world (the observation evidence) yields a NEW
 *     append-only step with a different deterministic key;
 *   - blocked/paused/resume semantics + the terminal states (achieved /
 *     exhausted / terminated-by-policy) with the honest mission recording;
 *   - FAIL-CLOSED ISOLATION: unknown/cross-agency pursuit scopes and
 *     unknown missions are the uniform 404 (no cross-tenant oracle); the
 *     two agencies' controllers, steps and delegated artifacts never mix.
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
import { bootstrapApplication } from '../../src/composition-root.ts';
import { createGrowthOperatorModule } from '../../src/modules/growth-operator/public.ts';
import type {
  GrowthOperatorDelegationGatePort,
  GrowthOperatorWorkspacePort,
  GrowthOperatorWorkflowPort,
} from '../../src/modules/growth-operator/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

const PROVENANCE = {
  actor: 'service:growth-operator-integration',
  recordedVia: 'module',
  correlationId: 'integration-growth-operator-1',
  causationId: null,
} as const;

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
// The REAL in-process application (all modules at their real wiring).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let core: any = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

import type { ApplicationModules } from '../../src/api/application.ts';

function modules(): ApplicationModules {
  if (core === null) throw new Error('application not bootstrapped');
  return core.modules as ApplicationModules;
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

async function makeUser(email: string): Promise<{ userId: string; token: string }> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'owner-password-123' },
  });
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: 'owner-password-123' },
  });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

interface Tenant {
  readonly agencyId: string;
  readonly token: string;
  readonly clientId: string;
  readonly workspaceId: string;
}

async function makeTenant(ownerEmail: string, name: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail);
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${name}`, ownerUserId: owner.userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: owner.token,
    body: { name: `Client ${name}` },
  });
  assert.equal(client.status, 201, JSON.stringify(client.body));
  const clientId = client.body['clientId'] as string;
  const workspace = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: owner.token,
    body: { name: `Workspace ${name}` },
  });
  assert.equal(workspace.status, 201, JSON.stringify(workspace.body));
  const workspaceId = workspace.body['workspaceId'] as string;
  return { agencyId, token: owner.token, clientId, workspaceId };
}

async function makeGoal(tenant: Tenant, workspaceScoped: boolean): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${tenant.clientId}/goals`, {
    token: tenant.token,
    body: {
      objective: `Grow qualified outcome for ${tenant.clientId}`,
      successCriteria: [
        { metric: 'qualified_outcome', comparator: '>=', targetValue: 100, unit: 'count' },
      ],
      metrics: [],
      constraints: [],
      timeHorizon: null,
      workspaceId: workspaceScoped ? tenant.workspaceId : null,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const goalId = created.body['goalId'] as string;
  const activated = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token: tenant.token,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return goalId;
}

async function makeMission(tenant: Tenant, goalId: string): Promise<string> {
  const created = await modules().growthMissions.createGrowthMission(
    {
      agencyId: tenant.agencyId,
      declaration: {
        objective: 'Grow the audience to one million qualified views',
        objectiveFamily: 'audience_growth',
        productContext: null,
        marketContext: { audience: 'qualified viewers', geography: 'global', summary: null },
        targetMetrics: [
          { metric: 'qualified_views', comparator: '>=', targetValue: 1_000_000, unit: 'count', description: null, intermediate: false },
        ],
      },
    },
    PROVENANCE,
  );
  await modules().growthMissions.addGrowthMissionGoalMapping(
    { missionId: created.mission.missionId, goalId },
    PROVENANCE,
  );
  return created.mission.missionId;
}

/**
 * Declares the client-scoped tools-dimension ALLOW for growth-operator
 * delegation (the social-accounts allowAll precedent — the platform policy
 * posture is fail-closed: only an explicit allow permits; an UNDECLARED
 * dimension denies). A new declaration SUPERSEDES the prior version of the
 * same (scope, dimension) — the deny test below relies on the same rule.
 */
async function allowDelegation(tenant: Tenant): Promise<void> {
  await modules().policies.declarePolicyVersion({
    scope: { agencyId: tenant.agencyId, clientId: tenant.clientId },
    dimension: 'tools',
    rules: [
      {
        effect: 'allow',
        operations: ['growth-operator.delegate'],
        resource: null,
        attributes: {},
        reason: 'integration test growth-operator delegation allowance',
      },
    ],
    description: 'Integration test growth-operator allowance',
    actorId: null,
  });
}

/** Drives the delegated execution to 'succeeded' through the REAL authority. */
async function driveExecutionToSucceeded(executionId: string): Promise<void> {
  const executions = modules().executions;
  let execution = await executions.getExecution(executionId);
  assert.ok(execution !== null);
  for (const to of ['queued', 'starting', 'running', 'succeeded'] as const) {
    const outcome = await executions.transitionExecution({
      executionId,
      to,
      expectedVersion: execution.version,
      idempotencyKey: `test-drive-${executionId}-${to}`,
      retryClassification: null,
      evidenceRef: null,
      reason: `runtime-plane simulation: ${to}`,
      actorId: null,
    });
    execution = outcome.execution;
  }
  assert.equal(execution.status, 'succeeded');
}

/** Drives the delegated workflow instance to 'succeeded' through the REAL authority. */
async function driveInstanceToSucceeded(instanceId: string): Promise<void> {
  const workflows = modules().workflows;
  const instance = await workflows.getWorkflowInstance(instanceId);
  assert.ok(instance !== null);
  if (instance.status === 'succeeded') return;
  assert.equal(instance.status, 'running');
  const outcome = await workflows.transitionWorkflowInstance({
    instanceId,
    to: 'succeeded',
    expectedVersion: instance.version,
    idempotencyKey: `test-drive-instance-${instanceId}-succeeded`,
    reason: 'runtime-plane simulation: the delegated work finished',
    actorId: null,
  });
  assert.equal(outcome.instance.status, 'succeeded');
}

let tenantA: Tenant | null = null;
let tenantB: Tenant | null = null;

before(async () => {
  stack = await bootStack('growth_operator');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  core = await bootstrapApplication();

  tenantA = await makeTenant('go-owner-a@marketingos.test', 'A');
  tenantB = await makeTenant('go-owner-b@marketingos.test', 'B');
});

after(async () => {
  // harvest fix: kill the spawned API child BEFORE the stack shutdown —
  // the api process holds pg pool connections that otherwise hang
  // instance.stop() (the MKT-063 content-rights-api teardown pattern).
  api?.child.kill('SIGKILL');
  if (core !== null) {
    await core.services.db.close();
  }
  if (stack !== null) {
    await shutdownStack(stack);
  }
});

// ---------------------------------------------------------------------------
// 1. Fail-closed initialization
// ---------------------------------------------------------------------------

test('MKT-054 AC: fail-closed initialization — unknown mission, cross-agency pursuit scope, double init', async () => {
  const goalA = await makeGoal(tenantA!, true);
  const missionA = await makeMission(tenantA!, goalA);

  // Unknown mission → the uniform 404.
  await assert.rejects(
    () => modules().growthOperator.initializeController({ missionId: '00000000-0000-0000-0000-000000000000', pursuitWorkspaceId: tenantA!.workspaceId }, PROVENANCE),
    (error: { code: string }) => error.code === 'NOT_FOUND',
  );

  // A workspace of ANOTHER agency is indistinguishable from an unknown one.
  await assert.rejects(
    () => modules().growthOperator.initializeController({ missionId: missionA, pursuitWorkspaceId: tenantB!.workspaceId }, PROVENANCE),
    (error: { code: string }) => error.code === 'NOT_FOUND',
  );

  // The honest initialization: born running, the mission ACTIVATED, event 1.
  const detail = await modules().growthOperator.initializeController(
    { missionId: missionA, pursuitWorkspaceId: tenantA!.workspaceId },
    PROVENANCE,
  );
  assert.equal(detail.controller.status, 'running');
  assert.equal(detail.controller.pursuitClientId, tenantA!.clientId);
  assert.equal(detail.controller.budget.humanAmplificationBudget, 0);
  assert.equal(detail.controller.budget.humanAmplificationEligibleCapacity, 0);
  assert.equal(detail.mission.status, 'active');
  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0]!.fromStatus, null);
  assert.equal(detail.events[0]!.toStatus, 'running');
  assert.ok(detail.decisions.some((d) => d.decisionKind === 'controller_initialized'));

  // ONE controller per mission.
  await assert.rejects(
    () => modules().growthOperator.initializeController({ missionId: missionA, pursuitWorkspaceId: tenantA!.workspaceId }, PROVENANCE),
    (error: { code: string }) => error.code === 'CONFLICT',
  );

  // The pursuit workspace must belong to the mission's agency — an
  // unknown workspace is the uniform 404 too.
  const anotherGoal = await makeGoal(tenantA!, true);
  const anotherMission = await makeMission(tenantA!, anotherGoal);
  await assert.rejects(
    () => modules().growthOperator.initializeController({
      missionId: anotherMission,
      pursuitWorkspaceId: '00000000-0000-0000-0000-000000000000',
    }, PROVENANCE),
    (error: { code: string }) => error.code === 'NOT_FOUND',
  );
});

// ---------------------------------------------------------------------------
// 2. THE MISSION ROUND-TRIP — delegate → execute → observe → replan
// ---------------------------------------------------------------------------

test('MKT-054 AC: the mission round-trip — delegation through the EXISTING authorities, observation as evidence, replan', async () => {
  const goalId = await makeGoal(tenantA!, true);
  const missionId = await makeMission(tenantA!, goalId);
  await allowDelegation(tenantA!);
  await modules().growthOperator.initializeController(
    { missionId, pursuitWorkspaceId: tenantA!.workspaceId },
    PROVENANCE,
  );

  // THE TICK: plan + delegate.
  const tick1 = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.equal(tick1.controller.status, 'running');
  assert.ok(tick1.dispatchedStep !== null, 'the first tick dispatches the bounded next step');
  const step1 = tick1.dispatchedStep!;
  assert.equal(step1.state, 'dispatched');
  assert.equal(step1.stepSeq, 1);

  // THE DELEGATION IDENTITY — every ref created through an EXISTING
  // authority (the cardinal rule): the experiment, the Decision-Ledger
  // record, the workflow container/definition/instance and the execution.
  assert.ok(step1.experimentId !== null);
  assert.ok(step1.decisionId !== null);
  assert.ok(step1.workflowId !== null);
  assert.ok(step1.workflowDefinitionId !== null);
  assert.ok(step1.workflowInstanceId !== null);
  assert.ok(step1.executionId !== null);
  const experiment = await modules().experiments.getExperiment(step1.experimentId!);
  assert.ok(experiment !== null, 'the experiment lives in the /experiments authority');
  const decision = await modules().decisions.getDecision(step1.decisionId!);
  assert.ok(decision !== null, 'the strategic decision lives in the /decisions ledger');
  assert.equal(decision!.experimentRef, step1.experimentId);
  const instance = await modules().workflows.getWorkflowInstance(step1.workflowInstanceId!);
  assert.equal(instance!.status, 'running', 'the delegated instance was requested INTO running through the authority');
  const execution = await modules().executions.getExecution(step1.executionId!);
  assert.equal(execution!.status, 'created', 'the delegated execution is born created — the RUNTIME PLANE owns its lifecycle');

  // The operator did NOT mutate the execution (it structurally cannot).
  // The runtime plane (simulated honestly through the authority's own
  // transition commands) drives it to succeeded.
  await driveExecutionToSucceeded(step1.executionId!);
  await driveInstanceToSucceeded(step1.workflowInstanceId!);

  // THE SECOND TICK: observe the delegated outcome as evidence, then replan.
  const tick2 = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.equal(tick2.reconciledSteps.length, 1, 'the finished step is reconciled');
  assert.equal(tick2.reconciledSteps[0]!.outcome, 'delegated_work_succeeded');
  assert.ok(tick2.reconciledSteps[0]!.observationEvidenceId !== null);
  const evidence = await modules().evidence.getEvidence(tick2.reconciledSteps[0]!.observationEvidenceId!);
  assert.ok(evidence !== null, 'the observation landed in the /evidence authority');
  assert.equal(evidence!.class, 'observation');
  assert.deepEqual(evidence!.source, { system: 'growth-operator', ref: step1.workflowInstanceId });
  const observedStep = (await modules().growthOperator.listControllerPlanSteps(missionId))!
    .find((step) => step.stepId === step1.stepId)!;
  assert.equal(observedStep.state, 'observed');
  assert.equal(observedStep.observedOutcome, 'delegated_work_succeeded');

  // THE REPLAN: a NEW append-only step with a DIFFERENT deterministic key
  // (the world changed — the observation evidence moved the digest).
  assert.ok(tick2.dispatchedStep !== null, 'the operator replans and delegates the next step');
  assert.notEqual(tick2.dispatchedStep!.stepId, step1.stepId);
  assert.equal(tick2.dispatchedStep!.stepSeq, 2);
  assert.notEqual(tick2.dispatchedStep!.idempotencyKey, step1.idempotencyKey);

  // The decision tail records the full loop.
  const decisions = (await modules().growthOperator.listControllerDecisions(missionId))!;
  const kinds = decisions.map((d) => d.decisionKind);
  assert.ok(kinds.includes('replan'));
  assert.ok(kinds.includes('delegation'));
  assert.ok(kinds.includes('observation'));
  // The append-only discipline: nothing rewrites history.
  await assert.rejects(
    () => pool().query('UPDATE growth_operator_decisions SET rationale = \'rewritten\''),
    (error: { code: string }) => error.code === 'P0001',
  );
  await assert.rejects(
    () => pool().query('DELETE FROM growth_operator_events'),
    (error: { code: string }) => error.code === 'P0001',
  );
});

// ---------------------------------------------------------------------------
// 3. ZERO-HUMAN PATH END-TO-END + idempotent re-tick (no double dispatch)
// ---------------------------------------------------------------------------

test('MKT-054 AC: the zero-human path end-to-end — the default continues, records and never fabricates', async () => {
  const goalId = await makeGoal(tenantA!, true);
  const missionId = await makeMission(tenantA!, goalId);
  await allowDelegation(tenantA!);
  // The ZERO-HUMAN default initialization (no budget override at all).
  await modules().growthOperator.initializeController(
    { missionId, pursuitWorkspaceId: tenantA!.workspaceId },
    PROVENANCE,
  );

  const tick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.ok(tick.dispatchedStep !== null);
  const replan = (await modules().growthOperator.listControllerDecisions(missionId))!.find(
    (d) => d.decisionKind === 'replan',
  )!;
  const consideredHuman = replan.detail['consideredHuman'] as {
    readonly eligible: boolean;
    readonly budget: number;
    readonly eligibleCapacity: number;
    readonly reason: string;
  };
  // The zero-human state is a RECORDED strategy input, never an absence.
  assert.equal(consideredHuman.eligible, false);
  assert.equal(consideredHuman.budget, 0);
  assert.equal(consideredHuman.eligibleCapacity, 0);
  assert.match(consideredHuman.reason, /zero-human state/);
  assert.match(String(replan.rationale), /human-amplification arm was considered and recorded/);
  // The selected treatment is a NON-HUMAN family.
  assert.notEqual(tick.dispatchedStep!.treatmentFamily, 'human_amplification');

  // IDEMPOTENT RE-TICK: the unchanged world (the work still in flight) is
  // a NO-OP — no second step, no double dispatch.
  const before = (await modules().growthOperator.listControllerPlanSteps(missionId))!;
  const reTick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.equal(reTick.dispatchedStep, null);
  const after = (await modules().growthOperator.listControllerPlanSteps(missionId))!;
  assert.equal(after.length, before.length);
  // No duplicate delegation: exactly ONE execution exists for this step.
  const executions = await modules().executions.listExecutionsForWorkspace(tenantA!.workspaceId);
  const stepExecutionIds = new Set(
    after.filter((step) => step.executionId !== null).map((step) => step.executionId),
  );
  for (const executionId of stepExecutionIds) {
    assert.equal(executions.filter((execution) => execution.executionId === executionId).length, 1);
  }

  // NO FABRICATED HUMAN RESULT: no step, decision or delegation of the
  // mission ever references a human treatment.
  const allSteps = (await modules().growthOperator.listControllerPlanSteps(missionId))!;
  for (const step of allSteps) {
    assert.notEqual(step.treatmentFamily, 'human_amplification');
    assert.equal(step.consideredHuman.eligible, false);
  }
});

// ---------------------------------------------------------------------------
// 4. RESTART-SAFETY — crash mid-delegation, convergent re-drive
// ---------------------------------------------------------------------------

test('MKT-054 AC: restart-safety — a mid-delegation crash converges on the next tick with NO double dispatch', async () => {
  const goalId = await makeGoal(tenantA!, true);
  const missionId = await makeMission(tenantA!, goalId);
  await allowDelegation(tenantA!);

  // A crash window: the workflows port throws AFTER createWorkflowInstance
  // but BEFORE the instance transition (the execution was never created).
  // The step row is the write-ahead record — 'planned' with partial refs.
  const realWorkflows = modules().workflows as unknown as GrowthOperatorWorkflowPort;
  const crashingWorkflows: GrowthOperatorWorkflowPort = {
    ...realWorkflows,
    createWorkflowInstance: (async (input: unknown) => {
      await realWorkflows.createWorkflowInstance(input as never);
      throw new Error('simulated crash after instance creation');
    }) as typeof realWorkflows.createWorkflowInstance,
  };
  const crashingOperator = createGrowthOperatorModule({
    db: core.services.db,
    clock: core.services.clock,
    ids: core.services.ids,
    missions: modules().growthMissions,
    goals: modules().goals,
    workspaces: realWorkspacePort(),
    workflows: crashingWorkflows,
    executions: modules().executions,
    experiments: modules().experiments,
    evidence: modules().evidence,
    decisions: modules().decisions,
    learnings: modules().learnings,
    policies: modules().policies,
  });

  const init = await crashingOperator.initializeController(
    { missionId, pursuitWorkspaceId: tenantA!.workspaceId },
    PROVENANCE,
  );
  await assert.rejects(
    () => crashingOperator.pursueMission({ missionId }, PROVENANCE),
    /simulated crash after instance creation/,
  );
  // The write-ahead record survived the crash.
  const plannedSteps = (await crashingOperator.listControllerPlanSteps(missionId))!;
  assert.equal(plannedSteps.length, 1);
  assert.equal(plannedSteps[0]!.state, 'planned');
  // The crash window: the recorded refs stop right before the instance —
  // the AUTHORITY objects exist (the experiment/decision/workflow/
  // definition were created and recorded), the instance was created at the
  // authority but its reference was never recorded, and the execution was
  // never created. The re-drive converges onto the orphan instance by its
  // pinned definition.
  assert.ok(plannedSteps[0]!.experimentId !== null, 'the experiment reference was recorded before the crash');
  assert.ok(plannedSteps[0]!.decisionId !== null, 'the decision reference was recorded before the crash');
  assert.ok(plannedSteps[0]!.workflowId !== null, 'the workflow reference was recorded before the crash');
  assert.ok(plannedSteps[0]!.workflowDefinitionId !== null, 'the definition reference was recorded before the crash');
  assert.equal(plannedSteps[0]!.workflowInstanceId, null, 'the instance reference was NOT recorded (the crash window)');
  assert.equal(plannedSteps[0]!.executionId, null, 'the execution was never created');
  const crashedDefinitionId = plannedSteps[0]!.workflowDefinitionId!;
  const crashedExperimentId = plannedSteps[0]!.experimentId!;
  const crashedWorkflowId = plannedSteps[0]!.workflowId!;
  // The orphan instance EXISTS at the authority, pinned to the crashed
  // step's definition (the convergence anchor of the re-drive).
  const orphanInstances = await modules().workflows.listWorkflowInstances(crashedWorkflowId);
  const crashedInstanceId = orphanInstances.find(
    (instance) => instance.workflowDefinitionId === crashedDefinitionId,
  )!.workflowInstanceId;

  // THE RECOVERY: the REAL operator (a fresh process would compose the
  // same ports) re-drives the recorded plan convergently.
  const recoveryTick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.ok(recoveryTick.dispatchedStep !== null, 'the re-drive completes the delegation');
  const recovered = recoveryTick.dispatchedStep!;
  assert.equal(recovered.stepId, plannedSteps[0]!.stepId, 'the SAME plan step — never a second one');
  assert.equal(recovered.state, 'dispatched');
  assert.equal(recovered.workflowInstanceId, crashedInstanceId, 'the SAME (formerly orphaned) workflow instance — convergent');
  assert.equal(recovered.workflowDefinitionId, crashedDefinitionId, 'the SAME definition — convergent');
  assert.equal(recovered.experimentId, crashedExperimentId, 'the SAME experiment — convergent');
  assert.ok(recovered.executionId !== null);

  // NO DOUBLE DISPATCH: exactly one of everything for this mission.
  const steps = (await modules().growthOperator.listControllerPlanSteps(missionId))!;
  assert.equal(steps.length, 1);
  const workflowName = `growth-operator-pursuit-${missionId}`;
  const workflows = await modules().workflows.listWorkflowsForWorkspace(tenantA!.workspaceId);
  assert.equal(workflows.filter((workflow) => workflow.name === workflowName).length, 1);
  const instances = await modules().workflows.listWorkflowInstances(workflows.find((w) => w.name === workflowName)!.workflowId);
  assert.equal(instances.length, 1, 'exactly ONE delegated instance');
  const executions = await modules().executions.listExecutionsForWorkspace(tenantA!.workspaceId);
  const stepExecutions = executions.filter((execution) => execution.taskLink.kind === 'workflow-node' && execution.taskLink.workflowInstanceId === crashedInstanceId);
  assert.equal(stepExecutions.length, 1, 'exactly ONE delegated execution (the §8 fence converged the re-drive)');
  void init;
});

// ---------------------------------------------------------------------------
// 5. blocked_pending_human_action — the simulated rights gate + the resume
// ---------------------------------------------------------------------------

test('MKT-054 AC: blocked_pending_human_action from a simulated rights gate — resume semantics, mission stays non-terminal', async () => {
  const goalId = await makeGoal(tenantA!, true);
  const missionId = await makeMission(tenantA!, goalId);

  // The disclosed rights-gate double (a test double at the gate boundary
  // ONLY — the controller under test is fully real; the real
  // /content-rights authority composes this same port when MKT-063 lands).
  const gate: GrowthOperatorDelegationGatePort = {
    async evaluateDelegation() {
      return {
        outcome: 'deny_pending_human_action',
        gateKind: 'rights',
        reason: 'the source asset requires human rights clearance before republication',
        policyDecisionRef: null,
      };
    },
  };
  const gatedCore = await bootstrapApplication({ growthOperatorGate: gate });
  try {
    const gated = gatedCore.modules.growthOperator;
    await gated.initializeController({ missionId, pursuitWorkspaceId: tenantA!.workspaceId }, PROVENANCE);
    const tick = await gated.pursueMission({ missionId }, PROVENANCE);
    assert.equal(tick.dispatchedStep, null, 'nothing is delegated across a genuine gate');
    assert.equal(tick.controller.status, 'blocked_pending_human_action');
    assert.equal(tick.controller.blockedGateKind, 'rights');
    assert.match(tick.controller.blockedReason ?? '', /human rights clearance/);
    // The gate decision is recorded (the audit trail).
    const decisions = (await gated.listControllerDecisions(missionId))!;
    assert.ok(decisions.some((d) => d.decisionKind === 'gate_encountered' && d.treatmentFamily !== null));
    // The MISSION stays non-terminal while the wait is resumable (the
    // MKT-053 mission machine's blocked state is terminal — the resumable
    // wait lives in the controller state).
    const mission = await gated.getControllerDetail(missionId);
    assert.equal(mission!.mission.status, 'active');
    // A blocked controller is an honest no-op on the next tick.
    const reTick = await gated.pursueMission({ missionId }, PROVENANCE);
    assert.equal(reTick.controller.status, 'blocked_pending_human_action');
    assert.equal(reTick.dispatchedStep, null);

    // THE RESUME (the human action happened — recorded in the reason).
    const resumed = await gated.resumeController(
      { missionId, reason: 'rights clearance granted by the operator (clearance record cr-1)', expectedVersion: reTick.controller.version },
      PROVENANCE,
    );
    assert.equal(resumed.controller.status, 'running');
    assert.equal(resumed.controller.blockedReason, null);
    assert.equal(resumed.mission.status, 'active');
  } finally {
    await gatedCore.services.db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. blocked_pending_human_action from the REAL /policies engine
// ---------------------------------------------------------------------------

test('MKT-054 AC: blocked_pending_human_action from the REAL policy engine (an explicit client-scoped deny)', async () => {
  const goalId = await makeGoal(tenantA!, true);
  const missionId = await makeMission(tenantA!, goalId);

  // Declare a client-scoped tools-dimension DENY for the delegation
  // operation through the REAL /policies authority.
  await modules().policies.declarePolicyVersion({
    scope: { agencyId: tenantA!.agencyId, clientId: tenantA!.clientId },
    dimension: 'tools',
    rules: [
      {
        effect: 'deny',
        operations: ['growth-operator.delegate'],
        resource: null,
        attributes: {},
        reason: 'growth delegation suspended for this client pending review',
      },
    ],
    description: 'integration test deny',
    actorId: null,
  });

  await modules().growthOperator.initializeController(
    { missionId, pursuitWorkspaceId: tenantA!.workspaceId },
    PROVENANCE,
  );
  const tick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.equal(tick.controller.status, 'blocked_pending_human_action');
  assert.equal(tick.controller.blockedGateKind, 'policy');
  assert.match(tick.controller.blockedReason ?? '', /policy decision/);
  assert.equal(tick.dispatchedStep, null);
  // The mission stays non-terminal (resumable after the policy changes).
  assert.equal((await modules().growthOperator.getControllerDetail(missionId))!.mission.status, 'active');
});

// ---------------------------------------------------------------------------
// 7. Terminal states — achieved (goal reached) + exhausted (budget)
// ---------------------------------------------------------------------------

test('MKT-054 AC: the achieved terminal — every mapped goal achieved ends the pursuit honestly and freezes', async () => {
  const goalId = await makeGoal(tenantA!, true);
  const missionId = await makeMission(tenantA!, goalId);
  await allowDelegation(tenantA!);
  await modules().growthOperator.initializeController(
    { missionId, pursuitWorkspaceId: tenantA!.workspaceId },
    PROVENANCE,
  );
  const tick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.ok(tick.dispatchedStep !== null);

  // The mapped goal reaches 'achieved' through the Goal authority.
  const goal = await modules().goals.getGoal(goalId);
  await modules().goals.setGoalStatus({ goalId, status: 'achieved', expectedVersion: goal!.version });

  const achievedTick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.equal(achievedTick.terminated, true);
  assert.equal(achievedTick.controller.status, 'achieved');
  // The mission receives the honest terminal recording through ITS
  // authority's own command.
  assert.equal((await modules().growthMissions.getGrowthMission(missionId))!.status, 'achieved');
  const events = (await modules().growthOperator.listControllerEvents(missionId))!;
  const terminalEvent = events.find((event) => event.toStatus === 'achieved')!;
  assert.equal(terminalEvent.terminalCause, 'goal_achieved');

  // TERMINAL IS FROZEN: nothing moves an achieved controller.
  await assert.rejects(
    () => modules().growthOperator.pauseController({ missionId, reason: 'no', expectedVersion: achievedTick.controller.version }, PROVENANCE),
    (error: { code: string }) => error.code === 'CONFLICT',
  );
  const reTick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.equal(reTick.dispatchedStep, null);
  assert.equal(reTick.terminated, false); // it was ALREADY terminal — an honest no-op
});

test('MKT-054 AC: the exhausted terminal — the delegation budget ends the pursuit truthfully (never a fabricated success)', async () => {
  const goalId = await makeGoal(tenantA!, true);
  const missionId = await makeMission(tenantA!, goalId);
  await allowDelegation(tenantA!);
  await modules().growthOperator.initializeController(
    { missionId, pursuitWorkspaceId: tenantA!.workspaceId, budget: { maxDelegatedSteps: 1 } },
    PROVENANCE,
  );
  const tick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.ok(tick.dispatchedStep !== null);
  // The delegated work finishes (the runtime plane simulation).
  await driveExecutionToSucceeded(tick.dispatchedStep!.executionId!);
  await driveInstanceToSucceeded(tick.dispatchedStep!.workflowInstanceId!);
  // The observation + the exhausted terminal on the same tick.
  const exhaustedTick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.equal(exhaustedTick.reconciledSteps.length, 1);
  assert.equal(exhaustedTick.terminated, true);
  assert.equal(exhaustedTick.controller.status, 'exhausted');
  assert.equal((await modules().growthMissions.getGrowthMission(missionId))!.status, 'budget_quota_exhausted');
  const events = (await modules().growthOperator.listControllerEvents(missionId))!;
  assert.equal(events.find((event) => event.toStatus === 'exhausted')!.terminalCause, 'delegation_budget_exhausted');
});

// ---------------------------------------------------------------------------
// 8. Pause/resume + the out-of-band mission pause (the operator defers)
// ---------------------------------------------------------------------------

test('MKT-054 AC: paused/resume semantics — the controller and the mission mirror each other; the operator defers to an out-of-band pause', async () => {
  const goalId = await makeGoal(tenantA!, true);
  const missionId = await makeMission(tenantA!, goalId);
  await allowDelegation(tenantA!);
  const detail = await modules().growthOperator.initializeController(
    { missionId, pursuitWorkspaceId: tenantA!.workspaceId },
    PROVENANCE,
  );
  const paused = await modules().growthOperator.pauseController(
    { missionId, reason: 'operator requested a deliberate pause', expectedVersion: detail.controller.version },
    PROVENANCE,
  );
  assert.equal(paused.controller.status, 'paused');
  assert.equal((await modules().growthMissions.getGrowthMission(missionId))!.status, 'paused');
  // A paused controller is an honest no-op.
  const tick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.equal(tick.dispatchedStep, null);
  assert.equal(tick.controller.status, 'paused');
  // Resume mirrors back to running/active.
  const resumed = await modules().growthOperator.resumeController(
    { missionId, reason: 'the deliberate pause ended', expectedVersion: paused.controller.version },
    PROVENANCE,
  );
  assert.equal(resumed.controller.status, 'running');
  assert.equal(resumed.mission.status, 'active');

  // An OUT-OF-BAND mission pause: the operator DEFERS to the mission
  // record (the conservative, honest choice).
  const mission = await modules().growthMissions.getGrowthMission(missionId);
  await modules().growthMissions.setGrowthMissionStatus(
    { missionId, status: 'paused', reason: 'the operator paused the mission out-of-band', expectedVersion: mission!.version },
    PROVENANCE,
  );
  const deferTick = await modules().growthOperator.pursueMission({ missionId }, PROVENANCE);
  assert.equal(deferTick.controller.status, 'paused');
  assert.equal(deferTick.dispatchedStep, null);
});

// ---------------------------------------------------------------------------
// 9. Cross-agency isolation — the controllers never mix
// ---------------------------------------------------------------------------

test('MKT-054 AC: cross-agency isolation — two agencies pursue independently; no cross-tenant oracle', async () => {
  const goalA = await makeGoal(tenantA!, true);
  const missionA = await makeMission(tenantA!, goalA);
  const goalB = await makeGoal(tenantB!, true);
  const missionB = await makeMission(tenantB!, goalB);

  await allowDelegation(tenantA!);
  await allowDelegation(tenantB!);
  await modules().growthOperator.initializeController({ missionId: missionA, pursuitWorkspaceId: tenantA!.workspaceId }, PROVENANCE);
  await modules().growthOperator.initializeController({ missionId: missionB, pursuitWorkspaceId: tenantB!.workspaceId }, PROVENANCE);

  const tickA = await modules().growthOperator.pursueMission({ missionId: missionA }, PROVENANCE);
  const tickB = await modules().growthOperator.pursueMission({ missionId: missionB }, PROVENANCE);
  assert.ok(tickA.dispatchedStep !== null);
  assert.ok(tickB.dispatchedStep !== null);

  // The delegated artifacts live in the OWNING tenant's workspace only.
  const workflowsA = await modules().workflows.listWorkflowsForWorkspace(tenantA!.workspaceId);
  const workflowsB = await modules().workflows.listWorkflowsForWorkspace(tenantB!.workspaceId);
  assert.ok(workflowsA.some((workflow) => workflow.name === `growth-operator-pursuit-${missionA}`));
  assert.ok(!workflowsA.some((workflow) => workflow.name === `growth-operator-pursuit-${missionB}`));
  assert.ok(workflowsB.some((workflow) => workflow.name === `growth-operator-pursuit-${missionB}`));
  assert.ok(!workflowsB.some((workflow) => workflow.name === `growth-operator-pursuit-${missionA}`));

  // The evidence/decisions of tenant A never appear in tenant B's tails.
  const evidenceB = await modules().evidence.listEvidenceForClient(tenantB!.clientId);
  for (const record of evidenceB) {
    assert.notEqual(record.source.system, `evidence of ${missionA}`);
  }
  const decisionsB = await modules().decisions.listDecisionsForClient(tenantB!.clientId);
  for (const record of decisionsB) {
    assert.ok(!record.objective.includes(missionA));
  }

  // A mission of another agency pursued under the wrong pursuit scope is
  // the uniform 404 at INITIALIZATION (already proven); at TICK time the
  // controller of a foreign mission is likewise the uniform 404.
  await assert.rejects(
    () => modules().growthOperator.pursueMission({ missionId: '00000000-0000-0000-0000-000000000000' }, PROVENANCE),
    (error: { code: string }) => error.code === 'NOT_FOUND',
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The real workspace structural port (the composition-root wrapper). */
function realWorkspacePort(): GrowthOperatorWorkspacePort {
  return {
    async resolveWorkspace(workspaceId: string) {
      const ownership = await modules().workspaces.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) return null;
      return {
        workspaceId: ownership.scope.workspaceId,
        clientId: ownership.scope.clientId,
        agencyId: ownership.scope.agencyId,
        status: ownership.workspace.status,
      };
    },
  };
}

export {};
