/**
 * MKT-028 integration test — THE ACQUISITION PILOT FLOW END-TO-END on the
 * real stack (embedded PostgreSQL 18 + real API subprocess + real drain-mode
 * worker subprocess + the wiring service constructed IN-PROCESS through
 * bootstrapApplication() against the SAME database the API serves — the
 * sanctioned test-harness wiring; the remaining flow is driven through the
 * real HTTP API).
 *
 * Acceptance mapping (work-item-matrix.md MKT-028 = E2E-001
 * "pilot end-to-end evidence; E2E-AC-01" — "a complete pilot can execute
 * using at least one AI path, one human field-agent path, and one extension
 * path with a shared Goal/Workflow/Evidence lifecycle — end-to-end
 * integration test"):
 *
 * THE GOLDEN PATH (E2E-AC-01):
 *   Goal (active, workspace-scoped) → deployAcquisitionPilot (playbook
 *   version PUBLISHED + workflow definition ACTIVE + §16 experiment
 *   declared, all through the authority publics) → bounded instance start
 *   (the five fail-closed bounds) → DIGITAL leg: /executions AI-class
 *   pooled execution dispatched through the real HTTP route, drained by a
 *   REAL worker subprocess, SUCCEEDED with a content-addressed artifact →
 *   FIELD leg: §18 Job projected from the template's human_task node,
 *   offered to an eligible field agent, accepted, visit opened/started,
 *   field evidence captured, structured outcome completed, job outcome
 *   submitted with required evidence → commissioning-side outcome evidence
 *   through /evidence → /metrics observations with evidence provenance →
 *   guardrail evaluation (not breached) → §16 experiment concluded with a
 *   resulting decision citing same-Client evidence → the derived pilot
 *   status re-reads the full chain from the authorities.
 *
 * NEGATIVE TESTS (boundedness + authority discipline):
 *   - the instance cap blocks the 4th start (append-only history counts);
 *   - the live-instance cap blocks a concurrent second start;
 *   - a TERMINAL goal blocks new pilot starts;
 *   - a STOPPED experiment blocks future starts while recorded history
 *     stays byte-for-byte intact (stop-only-future);
 *   - a guardrail breach is EXPOSED through the evaluation and blocks new
 *     starts;
 *   - authority bypass: a foreign goal is the SAME uniform 404 as an
 *     unknown goal; a DRAFT goal is refused fail-closed with ZERO partial
 *     writes (no playbook is created);
 *   - tenant isolation: a cross-Client evidence citation in the conclusion
 *     is a uniform 404 through the /experiments authority; a foreign
 *     tenant cannot read the pilot's job over HTTP (uniform 404).
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
import { AcquisitionPilotFlow } from '../../src/workers/acquisition-pilot/pilot-flow.ts';
import type { AcquisitionPilotDeployment } from '../../src/workers/acquisition-pilot/contract.ts';
import {
  ACQ_GUARDRAIL_COST,
  ACQ_PRIMARY_METRIC,
  ACQUISITION_PILOT_BOUNDS,
} from '../../src/workers/acquisition-pilot/template.ts';
import { ConflictError, NotFoundError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PASSWORD = 'a-very-long-password-123';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcessLike & { port: number }) | null = null;
let flow: AcquisitionPilotFlow | null = null;

interface SpawnedProcessLike {
  readonly child: ChildProcessWithoutNullStreams;
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('acqpilot');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring: bootstrap the SAME application
  // in-process (same embedded PostgreSQL the API subprocess serves) and
  // construct the acquisition-pilot composition service over the module
  // public contracts.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  flow = new AcquisitionPilotFlow({
    goals: core.modules.goals,
    playbooks: core.modules.playbooks,
    workflows: core.modules.workflows,
    executions: core.modules.executions,
    jobs: core.modules.jobs,
    evidence: core.modules.evidence,
    metrics: core.modules.metrics,
    experiments: core.modules.experiments,
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
// Shared fixtures (agency → client → workspace + owner; field agents)
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
  const owner = await makeUser(`${label}-owner@acqpilot.test`);
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

/** Creates an ACTIVE workspace-scoped Goal through the /goals HTTP surface. */
async function makeActiveGoal(tenant: Tenant, label: string): Promise<{ goalId: string; version: number }> {
  const create = await apiCall(port(), `/api/clients/${tenant.clientId}/goals`, {
    token: tenant.owner.token,
    body: {
      objective: `Acquisition pilot goal ${label}: prove qualified-lead motion within the cost guardrail`,
      workspaceId: tenant.workspaceId,
      successCriteria: [
        {
          metric: ACQ_PRIMARY_METRIC.name,
          comparator: '>=',
          targetValue: 1,
          unit: 'count',
          description: 'at least one qualified lead within the pilot window',
        },
      ],
      metrics: [],
      constraints: [{ kind: 'resource', description: 'pilot cost within the declared guardrail' }],
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

/** Deploys the pilot for a fresh active goal of a fresh tenant. */
async function makeDeployedPilot(label: string): Promise<{
  tenant: Tenant;
  goalId: string;
  deployment: AcquisitionPilotDeployment;
}> {
  const tenant = await makeTenant(label);
  const goal = await makeActiveGoal(tenant, label);
  const deployment = await flow!.deployAcquisitionPilot({
    goalId: goal.goalId,
    actorId: tenant.owner.userId,
    correlation: { correlationId: `acq-deploy-${label}`, causationId: null },
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
      dimensions: { pilot: 'acquisition' },
      value,
      unit,
      sourceSystem: 'acquisition-pilot',
      sourceRef: 'pilot-instance',
      observedAt: new Date().toISOString(),
      quality: 'ok',
      ...(evidenceRef === null ? {} : { evidenceRef }),
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
}

// ---------------------------------------------------------------------------
// THE GOLDEN PATH — E2E-AC-01 end-to-end pilot evidence
// ---------------------------------------------------------------------------

test('E2E-001 golden path: goal → deployed pilot → running instance → AI pooled execution (real worker) → §18 field job → evidence → metrics → experiment decision → derived status', async () => {
  const { tenant, deployment } = await makeDeployedPilot('golden');

  // The deployment composed the template through the authority publics:
  // the playbook version is PUBLISHED and pinned, the workflow definition
  // is ACTIVE, the experiment is declared DRAFT with the §16 contract.
  const playbookVersions = await apiCall(port(), `/api/playbooks/${deployment.playbookId}/versions`, {
    token: tenant.owner.token,
  });
  assert.equal(playbookVersions.status, 200);
  const versionRow = (playbookVersions.body['versions'] as ReadonlyArray<Record<string, unknown>>).find(
    (row) => row['versionId'] === deployment.playbookVersionId,
  );
  assert.equal(versionRow!['status'], 'published');

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
    ACQ_PRIMARY_METRIC.name,
  );

  // ---- bounded start (the five fail-closed bounds all pass) -------------
  const started = await flow!.startAcquisitionPilotInstance({
    deployment,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'acq-start-golden', causationId: null },
  });
  assert.equal(started.instance.status, 'running');
  assert.equal(started.experiment.status, 'running');
  const workflowInstanceId = started.instance.workflowInstanceId;

  // ---- DIGITAL leg: AI-class pooled execution through the real stack ----
  const digital = await flow!.createDigitalExecution({
    deployment,
    workflowInstanceId,
    idempotencyKey: 'acq-digital-golden-1',
    actorId: tenant.owner.userId,
  });
  assert.equal(digital.execution.status, 'created');
  assert.equal(digital.execution.executionKind, 'ai');
  assert.equal(digital.execution.runtimeClass, 'pooled-worker');
  assert.equal(digital.execution.taskLink.kind, 'workflow-node');

  const dispatch = await apiCall(port(), `/api/executions/${digital.execution.executionId}/dispatch`, {
    token: tenant.owner.token,
    body: {
      taskKind: 'data.transform',
      input: {
        records: [
          { channel: 'social', prospect: 'p1', score: 82 },
          { channel: 'search', prospect: 'p2', score: 91 },
          { channel: 'social', prospect: 'p3', score: 44 },
        ],
        sortBy: 'score',
      },
      idempotencyKey: 'acq-digital-dispatch-golden-1',
    },
  });
  assert.equal(dispatch.status, 201, JSON.stringify(dispatch.body));

  // A REAL drain-mode worker subprocess drives the execution to terminal.
  const worker = await spawnWorker(stack!.env);
  assert.equal(await worker.exitCode(), 0, 'drain worker exits cleanly');

  const finalExecution = await waitTerminalExecution(digital.execution.executionId, tenant.owner.token);
  assert.equal(finalExecution['status'], 'succeeded');

  // The content-addressed artifact exists and matches its digest — the
  // digital leg's durable output evidence.
  const dispatchRead = await apiCall(
    port(),
    `/api/executions/${digital.execution.executionId}/dispatch`,
    { token: tenant.owner.token },
  );
  const outputRef = (dispatchRead.body['dispatch'] as Record<string, unknown>)['outputRef'] as string;
  assert.ok(typeof outputRef === 'string' && outputRef.length === 64);
  const artifactPath = path.join(stack!.env.objectStoreDir, outputRef.slice(0, 2), outputRef);
  const artifactBytes = fs.readFileSync(artifactPath);
  assert.equal(createHash('sha256').update(artifactBytes).digest('hex'), outputRef);

  // ---- FIELD leg: the §18 contract through the real HTTP surfaces -------
  const job = await flow!.projectFieldJob({ deployment, workflowInstanceId, actorId: tenant.owner.userId });
  assert.equal(job.status, 'projected');
  assert.equal(job.workflowInstanceId, workflowInstanceId);
  assert.equal(job.nodeId, 'acq_field_visit');
  assert.equal(job.clientId, tenant.clientId);

  const agent = await makeFieldAgent('golden-agent@acqpilot.test');
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
        notes: 'Three contacts left contact details and asked for follow-up.',
      },
    },
  });
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  const fieldEvidenceId = captured.body['evidenceId'] as string;
  assert.ok(typeof fieldEvidenceId === 'string' && fieldEvidenceId.length > 0);

  // The captured evidence is an /evidence record of the job's client with
  // field-agent provenance (EVID-AC-01..03 field subset).
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
  assert.equal((completed.body['outcome'] as Record<string, unknown>)['result'], 'succeeded');

  // Job outcome submission (§18): the accepted agent reports with REQUIRED
  // evidence.
  const outcome = await apiCall(port(), `/api/jobs/${job.jobId}/outcome`, {
    token: agent.token,
    body: {
      outcome: 'succeeded',
      evidenceRef: fieldEvidenceId,
    },
  });
  assert.equal(outcome.status, 201, JSON.stringify(outcome.body));
  assert.equal((outcome.body['job'] as Record<string, unknown>)['status'], 'outcome_submitted');
  assert.equal(
    ((outcome.body['outcome'] as Record<string, unknown>)['evidenceRef'] as string),
    fieldEvidenceId,
  );

  // ---- commissioning-side outcome evidence through /evidence -----------
  const outcomeEvidence = await flow!.recordOutcomeEvidence({
    deployment,
    observedAtIso: new Date().toISOString(),
    content: {
      pilot_instance: workflowInstanceId,
      digital_artifact_ref: outputRef,
      field_visit_result: 'succeeded',
      qualified_leads: 3,
      total_cost_usd: 420,
    },
    contentRef: outputRef,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'acq-outcome-golden', causationId: null },
  });
  assert.equal(outcomeEvidence.class, 'source_fact');
  assert.equal(outcomeEvidence.quality, 'B');
  assert.equal(outcomeEvidence.provenance.recordedVia, 'worker:acquisition-pilot');

  // ---- metrics with evidence provenance through /metrics ---------------
  await appendMetric(tenant, ACQ_PRIMARY_METRIC.name, 3, 'count', outcomeEvidence.evidenceId);
  await appendMetric(tenant, ACQ_GUARDRAIL_COST.name, 420, 'USD', outcomeEvidence.evidenceId);

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

  // ---- guardrail evaluation (NOT breached within bounds) ----------------
  const measurement = await flow!.evaluatePilotGuardrails(tenant.clientId);
  assert.equal(measurement.evaluation.breached, false);
  assert.equal(measurement.evaluation.primaryMetricTotal, 3);
  assert.equal(measurement.evaluation.guardrails[0]!.totalValue, 420);
  assert.equal(measurement.evaluation.guardrails[0]!.breached, false);

  // ---- §16 conclusion: resulting decision citing same-Client evidence ---
  const concluded = await flow!.concludeAcquisitionPilot({
    deployment,
    conclusion: {
      resultState: 'observation',
      resultingDecision:
        'Extend: the bounded pilot produced 3 qualified leads within the 500 USD cost guardrail — proceed to the next bounded iteration.',
      uncertaintyInterval: { lower: 1, upper: 5, level: 0.9 },
      assumptions: ['single-arm pre/post pilot window comparison'],
      sampleLimitations: ['one pilot instance — a prove-it-first sample, not a powered estimate'],
      confounders: ['seasonal footfall variation', 'concurrent brand campaign'],
      evidenceRefs: [fieldEvidenceId, outcomeEvidence.evidenceId],
    },
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'acq-conclude-golden', causationId: null },
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
  const transitionNames = transitions.map((row) => row['transition']);
  assert.deepEqual(transitionNames, ['mark_ready', 'start', 'begin_analysis', 'conclude']);
  const conclusionRow = transitions[transitions.length - 1]!;
  const conclusion = conclusionRow['conclusion'] as Record<string, unknown>;
  assert.deepEqual(conclusion['evidenceRefs'], [fieldEvidenceId, outcomeEvidence.evidenceId]);
  assert.deepEqual(conclusion['uncertainty'], { kind: 'interval', lower: 1, upper: 5, level: 0.9 });

  // ---- the instance reaches its terminal state through the authority ----
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
        idempotencyKey: `acq-golden-instance-succeeded`,
        reason: 'pilot instance concluded through the experiment authority',
      },
    },
  );
  assert.equal(instanceTerminal.status, 200, JSON.stringify(instanceTerminal.body));

  // ---- the derived pilot status re-reads the full chain -----------------
  const status = await flow!.getAcquisitionPilotStatus(deployment);
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
  assert.equal(status.measurement.primaryMetricTotal, 3);
  assert.equal(status.measurement.breached, false);
});

// ---------------------------------------------------------------------------
// NEGATIVE — boundedness: the instance cap (append-only history counts)
// ---------------------------------------------------------------------------

test('boundedness: the instance cap blocks the 4th start (every past instance counts)', async () => {
  const { tenant, deployment } = await makeDeployedPilot('cap');

  for (let index = 1; index <= ACQUISITION_PILOT_BOUNDS.maxInstancesPerPilot; index += 1) {
    const started = await flow!.startAcquisitionPilotInstance({
      deployment,
      actorId: tenant.owner.userId,
      correlation: { correlationId: `acq-cap-start-${index}`, causationId: null },
    });
    // Terminalize each instance through the workflow authority so the
    // LIVE cap never fires — only the total budget can block here.
    const terminal = await apiCall(
      port(),
      `/api/workflows/${deployment.workflowId}/instances/${started.instance.workflowInstanceId}/transitions`,
      {
        token: tenant.owner.token,
        body: {
          to: 'cancelled',
          version: started.instance.version,
          idempotencyKey: `acq-cap-cancel-${index}`,
          reason: 'boundedness test: release the live slot',
        },
      },
    );
    assert.equal(terminal.status, 200, JSON.stringify(terminal.body));
  }

  await assert.rejects(
    flow!.startAcquisitionPilotInstance({
      deployment,
      actorId: tenant.owner.userId,
      correlation: { correlationId: 'acq-cap-start-over', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /already has 3 instances/);
      assert.match(error.message, /at most 3/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// NEGATIVE — boundedness: the live-instance cap
// ---------------------------------------------------------------------------

test('boundedness: the live-instance cap blocks a concurrent second start', async () => {
  const { tenant, deployment } = await makeDeployedPilot('live');

  const first = await flow!.startAcquisitionPilotInstance({
    deployment,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'acq-live-1', causationId: null },
  });
  assert.equal(first.instance.status, 'running');

  await assert.rejects(
    flow!.startAcquisitionPilotInstance({
      deployment,
      actorId: tenant.owner.userId,
      correlation: { correlationId: 'acq-live-2', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /1 live \(non-terminal\) instances/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// NEGATIVE — boundedness: a terminal goal blocks the pilot
// ---------------------------------------------------------------------------

test('boundedness: a TERMINAL goal blocks new pilot starts (and deploy refuses non-active goals)', async () => {
  const { tenant, deployment } = await makeDeployedPilot('terminalgoal');

  // Abandon the goal through the /goals authority.
  const goalRead = await apiCall(port(), `/api/goals/${deployment.goalId}`, { token: tenant.owner.token });
  assert.equal(goalRead.status, 200);
  const abandoned = await apiCall(port(), `/api/goals/${deployment.goalId}/status`, {
    token: tenant.owner.token,
    method: 'PATCH',
    body: { status: 'abandoned', version: goalRead.body['version'] as number },
  });
  assert.equal(abandoned.status, 200);

  await assert.rejects(
    flow!.startAcquisitionPilotInstance({
      deployment,
      actorId: tenant.owner.userId,
      correlation: { correlationId: 'acq-terminal-start', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /is abandoned; no new pilot instance may start/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// NEGATIVE — stop-only-future: a stopped experiment blocks future starts
// while recorded history stays intact
// ---------------------------------------------------------------------------

test('boundedness: a STOPPED experiment blocks future starts and recorded history stays intact', async () => {
  const { tenant, deployment } = await makeDeployedPilot('stopped');

  const started = await flow!.startAcquisitionPilotInstance({
    deployment,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'acq-stopped-1', causationId: null },
  });
  assert.equal(started.instance.status, 'running');

  // Stop the experiment through the /experiments authority (running → stopped).
  const stop = await apiCall(port(), `/api/experiments/${deployment.experimentId}/transitions`, {
    token: tenant.owner.token,
    body: { transition: 'stop' },
  });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.equal(stop.body['status'], 'stopped');

  // The stop blocks FUTURE selection only.
  await assert.rejects(
    flow!.startAcquisitionPilotInstance({
      deployment,
      actorId: tenant.owner.userId,
      correlation: { correlationId: 'acq-stopped-2', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /is stopped/);
      assert.match(error.message, /never rewrites recorded history/);
      return true;
    },
  );

  // Recorded history is intact: the experiment record and its append-only
  // transition history are unchanged, and the started instance is still
  // there with its own history.
  const experimentRead = await apiCall(port(), `/api/experiments/${deployment.experimentId}`, {
    token: tenant.owner.token,
  });
  assert.equal(experimentRead.status, 200);
  assert.equal(experimentRead.body['status'], 'stopped');
  assert.equal(experimentRead.body['resultState'], 'undecided');

  const history = await apiCall(port(), `/api/experiments/${deployment.experimentId}/transitions`, {
    token: tenant.owner.token,
  });
  const transitions = history.body['transitions'] as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(
    transitions.map((row) => row['transition']),
    ['mark_ready', 'start', 'stop'],
  );

  const instances = await apiCall(port(), `/api/workflows/${deployment.workflowId}/instances`, {
    token: tenant.owner.token,
  });
  assert.equal(instances.status, 200);
  const instanceRows = instances.body['instances'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(instanceRows.length, 1);
  assert.equal(instanceRows[0]!['workflowInstanceId'], started.instance.workflowInstanceId);
  assert.equal(instanceRows[0]!['status'], 'running');
});

// ---------------------------------------------------------------------------
// NEGATIVE — guardrail breach: exposed by the evaluation, blocks new starts
// ---------------------------------------------------------------------------

test('boundedness: a guardrail breach is EXPOSED by the evaluation and blocks new starts', async () => {
  const { tenant, deployment } = await makeDeployedPilot('breach');

  // Append guardrail observations totalling past the threshold through the
  // /metrics authority.
  await appendMetric(tenant, ACQ_GUARDRAIL_COST.name, 350, 'USD', null);
  await appendMetric(tenant, ACQ_GUARDRAIL_COST.name, 220, 'USD', null);

  // The breach is EXPOSED through the derived evaluation (the pilot
  // surfaces the authority's own recorded state — nothing is hidden).
  const measurement = await flow!.evaluatePilotGuardrails(tenant.clientId);
  assert.equal(measurement.evaluation.breached, true);
  assert.equal(measurement.evaluation.guardrails[0]!.totalValue, 570);
  assert.equal(measurement.evaluation.guardrails[0]!.threshold, ACQUISITION_PILOT_BOUNDS.guardrailThresholds[ACQ_GUARDRAIL_COST.name]);
  assert.equal(measurement.evaluation.guardrails[0]!.breached, true);

  // And the breach blocks any new start (fail closed).
  await assert.rejects(
    flow!.startAcquisitionPilotInstance({
      deployment,
      actorId: tenant.owner.userId,
      correlation: { correlationId: 'acq-breach-start', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /guardrail breached/);
      assert.match(error.message, /pilot_cost_usd=570>500/);
      return true;
    },
  );

  // The recorded history of the breach (the metric observations) stays
  // readable through the /metrics authority — append-only, never erased.
  const metrics = await apiCall(port(), `/api/clients/${tenant.clientId}/metrics`, {
    token: tenant.owner.token,
  });
  assert.equal((metrics.body['observations'] as unknown[]).length, 2);
});

// ---------------------------------------------------------------------------
// NEGATIVE — authority bypass: uniform 404 + fail-closed draft refusal
// ---------------------------------------------------------------------------

test('authority bypass: an unknown goal and a TOMBSTONED-client goal are the SAME uniform 404; a DRAFT goal is refused with ZERO partial writes', async () => {
  const tenant = await makeTenant('bypass-a');

  // An UNKNOWN goal id is a uniform NotFoundError in-process (the composed
  // service resolves canonical ownership; a caller-supplied id is never
  // an authorization).
  const unknownError = await flow!.deployAcquisitionPilot({
    goalId: '00000000-0000-0000-0000-000000000000',
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'acq-bypass-unknown', causationId: null },
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(unknownError instanceof NotFoundError);
  assert.match(unknownError.message, /^goal not found:/);

  // A goal whose Client became a deleted TOMBSTONE resolves to the SAME
  // uniform NotFoundError — orphaned and unknown identifiers are
  // indistinguishable (the hard-boundary posture at the module boundary).
  const tomb = await makeTenant('bypass-tomb');
  const tombGoal = await makeActiveGoal(tomb, 'bypass-tomb');
  const clientRead = await apiCall(port(), `/api/clients/${tomb.clientId}`, { token: await adminToken() });
  assert.equal(clientRead.status, 200);
  const tombstone = await apiCall(port(), `/api/clients/${tomb.clientId}/status`, {
    token: await adminToken(),
    method: 'PATCH',
    body: { status: 'deleted', version: clientRead.body['version'] as number },
  });
  assert.equal(tombstone.status, 200, JSON.stringify(tombstone.body));

  const orphanError = await flow!.deployAcquisitionPilot({
    goalId: tombGoal.goalId,
    actorId: tomb.owner.userId,
    correlation: { correlationId: 'acq-bypass-orphan', causationId: null },
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(orphanError instanceof NotFoundError);
  assert.equal(
    orphanError.message,
    unknownError.message.replace('00000000-0000-0000-0000-000000000000', tombGoal.goalId),
    'unknown and orphaned goal ids are the SAME uniform 404',
  );

  // A DRAFT goal is refused fail-closed — and NO partial writes happened:
  // the client ends with zero pilot playbooks.
  const draftCreate = await apiCall(port(), `/api/clients/${tenant.clientId}/goals`, {
    token: tenant.owner.token,
    body: {
      objective: 'A draft goal that never activated',
      workspaceId: tenant.workspaceId,
      successCriteria: [
        { metric: 'draft_metric', comparator: '>=', targetValue: 1, unit: 'count', description: 'never activated' },
      ],
      metrics: [],
      constraints: [],
      timeHorizon: null,
    },
  });
  assert.equal(draftCreate.status, 201);
  const draftGoalId = draftCreate.body['goalId'] as string;

  await assert.rejects(
    flow!.deployAcquisitionPilot({
      goalId: draftGoalId,
      actorId: tenant.owner.userId,
      correlation: { correlationId: 'acq-bypass-draft', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /is draft; the acquisition pilot deploys only on active goals/);
      return true;
    },
  );

  const playbooks = await apiCall(port(), `/api/clients/${tenant.clientId}/playbooks`, {
    token: tenant.owner.token,
  });
  assert.equal(playbooks.status, 200);
  assert.equal((playbooks.body['playbooks'] as unknown[]).length, 0, 'fail-closed: no partial playbook writes');
});

// ---------------------------------------------------------------------------
// NEGATIVE — tenant isolation: cross-Client evidence citation is a uniform
// 404; a foreign tenant cannot read the pilot's job over HTTP
// ---------------------------------------------------------------------------

test('tenant isolation: a cross-Client evidence citation is a uniform 404 and foreign tenants get 404 over HTTP', async () => {
  const { tenant, deployment } = await makeDeployedPilot('iso-a');
  const other = await makeDeployedPilot('iso-b');

  const started = await flow!.startAcquisitionPilotInstance({
    deployment,
    actorId: tenant.owner.userId,
    correlation: { correlationId: 'acq-iso-start', causationId: null },
  });
  assert.equal(started.instance.status, 'running');

  // The pilot's §18 field job of tenant A.
  const job = await flow!.projectFieldJob({
    deployment,
    workflowInstanceId: started.instance.workflowInstanceId,
    actorId: tenant.owner.userId,
  });

  // A foreign tenant reads tenant A's job id over HTTP: uniform 404 (the
  // hard boundary — foreign and unknown ids are indistinguishable).
  const foreignRead = await apiCall(port(), `/api/jobs/${job.jobId}`, { token: other.tenant.owner.token });
  assert.equal(foreignRead.status, 404);

  // Tenant B appends its own evidence; tenant A's pilot conclusion citing
  // it is rejected by the /experiments authority with a uniform 404 (the
  // DB trigger backstops the same-Client fence).
  const foreignEvidence = await apiCall(port(), `/api/clients/${other.tenant.clientId}/evidence`, {
    token: other.tenant.owner.token,
    body: {
      class: 'observation',
      sourceSystem: 'acquisition-pilot',
      sourceRef: 'foreign-evidence',
      observedAt: new Date().toISOString(),
      content: { note: 'tenant B evidence' },
      quality: 'C',
    },
  });
  assert.equal(foreignEvidence.status, 201);
  const foreignEvidenceId = foreignEvidence.body['evidenceId'] as string;

  await assert.rejects(
    flow!.concludeAcquisitionPilot({
      deployment,
      conclusion: {
        resultState: 'observation',
        resultingDecision: 'must never land',
        uncertaintyInterval: { lower: 0, upper: 1, level: 0.9 },
        assumptions: [],
        sampleLimitations: [],
        confounders: [],
        evidenceRefs: [foreignEvidenceId],
      },
      actorId: tenant.owner.userId,
      correlation: { correlationId: 'acq-iso-conclude', causationId: null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NotFoundError, `expected NotFoundError, got ${String(error)}`);
      assert.match(error.message, /not found/);
      return true;
    },
  );

  // The experiment was NOT concluded (the fail-closed rejection left no
  // partial state): still running, still undecided.
  const experimentRead = await apiCall(port(), `/api/experiments/${deployment.experimentId}`, {
    token: tenant.owner.token,
  });
  assert.equal(experimentRead.body['status'], 'running');
  assert.equal(experimentRead.body['resultState'], 'undecided');
});
