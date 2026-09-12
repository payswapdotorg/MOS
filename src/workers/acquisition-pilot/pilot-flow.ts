/**
 * MKT-028 — THE ACQUISITION PILOT WIRING (the second deliverable: the
 * composition glue that drives the template package through the authority
 * public contracts — the sanctioned "test harness wiring" option from the
 * Work Order: this service is constructed by the integration harness
 * in-process through bootstrapApplication() against the SAME real embedded
 * PostgreSQL the API subprocess serves, while the remaining flow (dispatch,
 * §18 offers/acceptance/visits/outcomes, HTTP evidence/metrics appends) is
 * driven through the real HTTP API).
 *
 * AUTHORITY DISCIPLINE (the whole file — pinned by
 * tests/architecture/acquisition-pilot-boundary.test.ts):
 *
 *   - composes ONLY the frozen module PUBLIC contracts
 *     (/goals, /playbooks, /workflows, /executions, /jobs, /evidence,
 *     /metrics, /experiments) — never module internals, never direct SQL,
 *     never the database, never a migration;
 *   - the pilot owns NO durable state: every derived value is re-read from
 *     the authorities on every call (deploy/start/evaluate/status/conclude
 *     are state-driven, exactly like the MKT-011 pooled protocol);
 *   - every mutation goes through an authority's own mutation port
 *     (createGoal side: createClientPlaybook / createPlaybookVersion /
 *     setPlaybookVersionStatus / createWorkflow / createWorkflowDefinition /
 *     setWorkflowDefinitionStatus / createExperiment /
 *     applyExperimentTransition / createWorkflowInstance /
 *     transitionWorkflowInstance / createExecution / projectJob /
 *     appendEvidence) — the pilot NEVER writes another authority's tables
 *     and NEVER commands a state the authority does not expose;
 *   - START IS FAIL-CLOSED: the five documented bounds are checked BEFORE
 *     any write happens (goal live, experiment not stopped, instance cap,
 *     live-instance cap, guardrails not breached);
 *   - STOP ONLY BLOCKS THE FUTURE: a stopped/invalidated/concluded
 *     experiment blocks new instance selection but rewrites nothing —
 *     recorded history stays byte-for-byte (append-only authorities);
 *   - a caller-supplied identifier is NEVER an authorization: every
 *     operation re-resolves canonical ownership through the authority
 *     (resolveGoalOwnership) and surfaces uniform NotFoundErrors for
 *     foreign, unknown and orphaned identifiers alike.
 */

import { ConflictError, NotFoundError } from '../../platform/errors/errors.ts';
import type { GoalsModuleApi } from '../../modules/goals/public.ts';
import type { PlaybooksModuleApi } from '../../modules/playbooks/public.ts';
import type { WorkflowsModuleApi } from '../../modules/workflows/public.ts';
import type { ExecutionsModuleApi, ExecutionCreateOutcome } from '../../modules/executions/public.ts';
import type { JobsModuleApi, JobRecord } from '../../modules/jobs/public.ts';
import type { EvidenceModuleApi, EvidenceRecord } from '../../modules/evidence/public.ts';
import type { MetricsModuleApi } from '../../modules/metrics/public.ts';
import type {
  ExperimentProvenance,
  ExperimentRecord,
  ExperimentsModuleApi,
} from '../../modules/experiments/public.ts';
import type { EvidenceProvenance } from '../../modules/evidence/public.ts';
import type { WorkflowInstanceRecord } from '../../modules/workflows/public.ts';
import { isTerminalWorkflowInstanceStatus } from '../../modules/workflows/public.ts';
import {
  ACQ_DIGITAL_NODE,
  ACQ_FIELD_NODE,
  observationView,
  type AcquisitionPilotDeployment,
  type AcquisitionPilotStatus,
  type PilotConclusionInput,
  type PilotCorrelationInput,
  type PilotGuardrailEvaluation,
  type PilotInstanceSummary,
} from './contract.ts';
import {
  ACQUISITION_PILOT_BOUNDS,
  acquisitionPilotTemplate,
  buildFieldJobDescriptor,
  evaluatePilotGuardrails,
} from './template.ts';

/** The composed authority set — the frozen module PUBLIC contracts only. */
export interface AcquisitionPilotDeps {
  readonly goals: GoalsModuleApi;
  readonly playbooks: PlaybooksModuleApi;
  readonly workflows: WorkflowsModuleApi;
  readonly executions: ExecutionsModuleApi;
  readonly jobs: JobsModuleApi;
  readonly evidence: EvidenceModuleApi;
  readonly metrics: MetricsModuleApi;
  readonly experiments: ExperimentsModuleApi;
}

/** The derived measurement read: the evaluation plus the observations it consumed. */
export interface PilotMeasurementRead {
  readonly evaluation: PilotGuardrailEvaluation;
  readonly observationCount: number;
}

/**
 * THE ACQUISITION PILOT FLOW SERVICE — bounded composition over the frozen
 * authorities. Construct it anywhere the module publics are wired (the
 * composition root could hand it to a future entrypoint; the MKT-028
 * Work Order sanctions test-harness wiring — the integration harness
 * constructs it in-process).
 */
export class AcquisitionPilotFlow {
  private readonly deps: AcquisitionPilotDeps;

  constructor(deps: AcquisitionPilotDeps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // DEPLOY — Goal → Playbook Version (PUBLISHED) → Workflow Definition
  // (ACTIVE) → Experiment (DRAFT). All writes through the authority publics.
  // -------------------------------------------------------------------------

  /**
   * Deploys the acquisition pilot template for one Goal:
   *
   *   1. FAIL CLOSED (before any write): the Goal resolves through /goals
   *      canonical ownership (null → uniform NotFoundError — a foreign goal
   *      id is indistinguishable from an unknown one); the Goal must be
   *      ACTIVE (a draft or terminal goal cannot operationalize a pilot);
   *      the Goal must be WORKSPACE-SCOPED (the composed /workflows
   *      authority derives its client from the workspace chain — pinning
   *      the goal's own workspace guarantees the pilot workflow lands in
   *      the SAME client as the goal).
   *   2. /playbooks.createClientPlaybook — the Client-scoped playbook with
   *      the immutable Goal link.
   *   3. /playbooks.createPlaybookVersion + setPlaybookVersionStatus
   *      (draft → review → published — the frozen editorial pipeline).
   *   4. /workflows.createWorkflow (in the goal's workspace) +
   *      createWorkflowDefinition (§4-validated template graph, pinned to
   *      the published playbook version) + setWorkflowDefinitionStatus
   *      (draft → review → active).
   *   5. /experiments.createExperiment — the full §16 declaration with
   *      server-derived provenance (DRAFT lifecycle start).
   *
   * Returns the deployment descriptor (the explicit authority-owned ids).
   */
  async deployAcquisitionPilot(input: {
    readonly goalId: string;
    readonly actorId: string | null;
    readonly correlation: PilotCorrelationInput;
  }): Promise<AcquisitionPilotDeployment> {
    // ---- fail-closed bounds BEFORE any write -----------------------------
    const ownership = await this.deps.goals.resolveGoalOwnership(input.goalId);
    if (ownership === null) {
      // Uniform 404: foreign, unknown and orphaned goal ids are
      // indistinguishable (the hard-boundary posture).
      throw new NotFoundError('goal', input.goalId);
    }
    const goal = ownership.goal;
    if (goal.status !== 'active') {
      throw new ConflictError(
        `goal ${goal.goalId} is ${goal.status}; the acquisition pilot deploys only on active goals`,
      );
    }
    if (goal.workspaceId === null) {
      throw new ConflictError(
        `goal ${goal.goalId} is client-wide; the acquisition pilot requires a workspace-scoped goal so the composed workflow lands in the goal's own client`,
      );
    }
    // ---- writes through the authority publics ----------------------------

    const template = acquisitionPilotTemplate();

    const playbook = await this.deps.playbooks.createClientPlaybook({
      clientId: goal.clientId,
      goalId: goal.goalId,
      name: 'Acquisition pilot (prove-it-first)',
      description:
        'Bounded acquisition pilot: one digital outreach execution plus one field visit per instance, measured on qualified leads against a cost guardrail.',
      actorId: input.actorId,
    });

    let playbookVersion = await this.deps.playbooks.createPlaybookVersion({
      playbookId: playbook.playbookId,
      strategy: template.playbook.strategy,
      deploymentMetadata: template.playbook.deploymentMetadata,
      actorId: input.actorId,
    });
    for (const status of ['review', 'published'] as const) {
      playbookVersion = await this.deps.playbooks.setPlaybookVersionStatus({
        versionId: playbookVersion.versionId,
        status,
        expectedVersion: playbookVersion.version,
      });
    }

    const workflow = await this.deps.workflows.createWorkflow({
      workspaceId: goal.workspaceId,
      name: 'Acquisition pilot flow',
      description:
        'Prove-it-first acquisition pilot workflow: digital outreach (ai_task, pooled) + field visit (human_task, §18) joined into the pilot outcome.',
      actorId: input.actorId,
    });

    let definition = await this.deps.workflows.createWorkflowDefinition({
      workflowId: workflow.workflowId,
      content: template.workflowDefinition,
      playbookVersionId: playbookVersion.versionId,
      actorId: input.actorId,
    });
    for (const status of ['review', 'active'] as const) {
      definition = await this.deps.workflows.setWorkflowDefinitionStatus({
        definitionId: definition.workflowDefinitionId,
        status,
        expectedVersion: definition.version,
      });
    }

    const experiment = await this.deps.experiments.createExperiment(
      {
        clientId: goal.clientId,
        workspaceId: goal.workspaceId,
        ...template.experiment,
      },
      this.experimentProvenance(input.correlation),
    );

    return {
      goalId: goal.goalId,
      clientId: goal.clientId,
      workspaceId: goal.workspaceId,
      playbookId: playbook.playbookId,
      playbookVersionId: playbookVersion.versionId,
      workflowId: workflow.workflowId,
      workflowDefinitionId: definition.workflowDefinitionId,
      experimentId: experiment.experimentId,
    };
  }

  // -------------------------------------------------------------------------
  // START — one bounded pilot instance. THE FIVE FAIL-CLOSED BOUNDS are
  // checked BEFORE any write (pinned by the static boundary test).
  // -------------------------------------------------------------------------

  /**
   * Starts ONE pilot instance of a deployed pilot. The five bounds, in
   * order, all BEFORE any write:
   *
   *   1. GOAL LIVE — the goal re-resolves through /goals canonical
   *      ownership and is still ACTIVE (a terminal or draft goal blocks
   *      new pilot use);
   *   2. EXPERIMENT NOT STOPPED — the /experiments record re-reads and is
   *      in a startable state (draft/ready/running). A STOPPED, invalidated
   *      or concluded experiment blocks FUTURE instance selection only —
   *      recorded history is never rewritten (stop-only-future semantics);
   *   3. INSTANCE CAP — the total number of instances that EVER existed
   *      for the pilot workflow (append-only history, terminal states
   *      included) is under bounds.maxInstancesPerPilot;
   *   4. LIVE-INSTANCE CAP — the number of NON-TERMINAL instances is under
   *      bounds.maxConcurrentInstances;
   *   5. GUARDRAILS NOT BREACHED — the pure evaluation over the client's
   *      /metrics observations (name+dimensions identity) shows no
   *      guardrail over its threshold. A breach BLOCKS new starts.
   *
   * Then (state-driven, convergent): the experiment is advanced to RUNNING
   * (draft → ready → running; already-running converges without re-applying),
   * the workflow instance is created through /workflows and staged
   * draft → ready → running with pilot-scoped idempotency keys.
   */
  async startAcquisitionPilotInstance(input: {
    readonly deployment: AcquisitionPilotDeployment;
    readonly actorId: string | null;
    readonly correlation: PilotCorrelationInput;
  }): Promise<{ instance: WorkflowInstanceRecord; experiment: ExperimentRecord }> {
    const deployment = input.deployment;
    const bounds = ACQUISITION_PILOT_BOUNDS;

    // ---- bound 1: the goal must still be live ----------------------------
    const ownership = await this.deps.goals.resolveGoalOwnership(deployment.goalId);
    if (ownership === null) {
      throw new NotFoundError('goal', deployment.goalId);
    }
    if (ownership.goal.status !== 'active') {
      throw new ConflictError(
        `goal ${deployment.goalId} is ${ownership.goal.status}; no new pilot instance may start`,
      );
    }

    // ---- bound 2: a stopped experiment blocks future selection only ------
    const experiment = await this.deps.experiments.getExperiment(deployment.experimentId);
    if (experiment === null) {
      throw new NotFoundError('experiment', deployment.experimentId);
    }
    if (experiment.status === 'stopped' || experiment.status === 'invalidated' || experiment.status === 'concluded') {
      throw new ConflictError(
        `experiment ${deployment.experimentId} is ${experiment.status}; stopping blocks future pilot instance selection only and never rewrites recorded history`,
      );
    }

    // ---- bound 3: the total instance budget ------------------------------
    const instances = await this.deps.workflows.listWorkflowInstances(deployment.workflowId);
    if (instances.length >= bounds.maxInstancesPerPilot) {
      throw new ConflictError(
        `pilot workflow ${deployment.workflowId} already has ${instances.length} instances (append-only history, terminal included); the bounded pilot allows at most ${bounds.maxInstancesPerPilot}`,
      );
    }

    // ---- bound 4: the live-instance cap ----------------------------------
    const liveCount = instances.filter((instance) => !isTerminalWorkflowInstanceStatus(instance.status)).length;
    if (liveCount >= bounds.maxConcurrentInstances) {
      throw new ConflictError(
        `pilot workflow ${deployment.workflowId} already has ${liveCount} live (non-terminal) instances; the bounded pilot allows at most ${bounds.maxConcurrentInstances} at a time`,
      );
    }

    // ---- bound 5: guardrails must not be breached -------------------------
    const measurement = await this.readMeasurement(deployment.clientId);
    if (measurement.evaluation.breached) {
      const breached = measurement.evaluation.guardrails
        .filter((guardrail) => guardrail.breached)
        .map((guardrail) => `${guardrail.name}=${guardrail.totalValue}>${guardrail.threshold}`)
        .join(', ');
      throw new ConflictError(
        `pilot guardrail breached for client ${deployment.clientId}: ${breached}; no new pilot instance may start`,
      );
    }

    // ---- writes (state-driven convergence) --------------------------------
    let current = experiment;
    if (current.status === 'draft') {
      current = await this.deps.experiments.applyExperimentTransition(
        current.experimentId,
        { transition: 'mark_ready', conclusion: null },
        this.experimentProvenance(input.correlation),
      );
    }
    if (current.status === 'ready') {
      current = await this.deps.experiments.applyExperimentTransition(
        current.experimentId,
        { transition: 'start', conclusion: null },
        this.experimentProvenance(input.correlation),
      );
    }

    let instance = await this.deps.workflows.createWorkflowInstance({
      workflowId: deployment.workflowId,
      workflowDefinitionId: deployment.workflowDefinitionId,
      actorId: input.actorId,
    });
    for (const to of ['ready', 'running'] as const) {
      const outcome = await this.deps.workflows.transitionWorkflowInstance({
        instanceId: instance.workflowInstanceId,
        to,
        expectedVersion: instance.version,
        idempotencyKey: `acquisition-pilot:${instance.workflowInstanceId}:${to}`,
        reason: `acquisition pilot instance ${to}`,
        actorId: input.actorId,
      });
      instance = outcome.instance;
    }

    return { instance, experiment: current };
  }

  // -------------------------------------------------------------------------
  // THE TWO EXECUTION LEGS — thin, bounded compositions over the runtime
  // and marketplace authorities (the E2E drives dispatch + the §18 offer/
  // acceptance/visit/outcome chain through the real HTTP surfaces).
  // -------------------------------------------------------------------------

  /**
   * Creates the DIGITAL leg execution: one /executions runtime attempt for
   * the template's `ai_task` node (AI execution kind, pooled-worker runtime
   * class — the MKT-011 default leg), born CREATED with the caller's §8
   * logical idempotency key. Dispatch happens through the pooled runtime
   * surface (the HTTP dispatch route in the E2E); the pilot never touches
   * the queue or the dispatch outbox.
   */
  async createDigitalExecution(input: {
    readonly deployment: AcquisitionPilotDeployment;
    readonly workflowInstanceId: string;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<ExecutionCreateOutcome> {
    return this.deps.executions.createExecution({
      workspaceId: input.deployment.workspaceId,
      taskLink: {
        kind: 'workflow-node',
        workflowInstanceId: input.workflowInstanceId,
        nodeId: ACQ_DIGITAL_NODE,
      },
      retryOfExecutionId: null,
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
    });
  }

  /**
   * Projects the FIELD leg job: the template's `human_task` node projected
   * into a §18 field Job with the template's public descriptor
   * (profile-data-only eligibility — NO Client data). The /jobs authority
   * re-validates the RUNNING instance + node class and derives the scope
   * chain server-side. Offers, acceptance, the visit lifecycle and the
   * structured outcome are driven through the /jobs surfaces (HTTP in the
   * E2E) — the pilot composes the projection only.
   */
  async projectFieldJob(input: {
    readonly deployment: AcquisitionPilotDeployment;
    readonly workflowInstanceId: string;
    readonly actorId: string | null;
  }): Promise<JobRecord> {
    return this.deps.jobs.projectJob({
      workflowInstanceId: input.workflowInstanceId,
      nodeId: ACQ_FIELD_NODE,
      descriptor: buildFieldJobDescriptor(),
      actorId: input.actorId,
    });
  }

  /**
   * Records the commissioning-side PILOT OUTCOME EVIDENCE through the
   * /evidence public contract: the authoritative outcome facts (the digital
   * artifact reference, the field result summary) as a source_fact row of
   * the goal's client, with server-derived provenance. The experiment
   * conclusion cites this record (same-Client, DB-fenced).
   */
  async recordOutcomeEvidence(input: {
    readonly deployment: AcquisitionPilotDeployment;
    readonly observedAtIso: string;
    readonly content: Readonly<Record<string, unknown>>;
    readonly contentRef: string | null;
    readonly actorId: string | null;
    readonly correlation: PilotCorrelationInput;
  }): Promise<EvidenceRecord> {
    return this.deps.evidence.appendEvidence(
      {
        clientId: input.deployment.clientId,
        workspaceId: input.deployment.workspaceId,
        class: 'source_fact',
        source: { system: 'acquisition-pilot', ref: input.deployment.goalId },
        observedAt: input.observedAtIso,
        content: input.content,
        contentRef: input.contentRef,
        quality: 'B',
        confidence: null,
        supersedesEvidenceId: null,
      },
      this.evidenceProvenance(input.correlation),
    );
  }

  // -------------------------------------------------------------------------
  // MEASURE — the pure evaluation over the client's /metrics observations
  // -------------------------------------------------------------------------

  /** Reads the client's observations and runs the pure guardrail evaluation. */
  async evaluatePilotGuardrails(clientId: string): Promise<PilotMeasurementRead> {
    return this.readMeasurement(clientId);
  }

  // -------------------------------------------------------------------------
  // STATUS — the fully derived snapshot (the pilot owns NO state)
  // -------------------------------------------------------------------------

  /**
   * The DERIVED pilot status: goal, playbook version, workflow definition,
   * experiment (status + result state + resulting decision), every instance
   * (with terminal flags), the live count and the guardrail evaluation —
   * each field re-read from its authority at call time.
   */
  async getAcquisitionPilotStatus(deployment: AcquisitionPilotDeployment): Promise<AcquisitionPilotStatus> {
    const goal = await this.deps.goals.getGoal(deployment.goalId);
    if (goal === null) throw new NotFoundError('goal', deployment.goalId);
    const playbookVersion = await this.deps.playbooks.getPlaybookVersion(deployment.playbookVersionId);
    if (playbookVersion === null) throw new NotFoundError('playbook_version', deployment.playbookVersionId);
    const definition = await this.deps.workflows.getWorkflowDefinition(deployment.workflowDefinitionId);
    if (definition === null) throw new NotFoundError('workflow_definition', deployment.workflowDefinitionId);
    const experiment = await this.deps.experiments.getExperiment(deployment.experimentId);
    if (experiment === null) throw new NotFoundError('experiment', deployment.experimentId);

    const instances = await this.deps.workflows.listWorkflowInstances(deployment.workflowId);
    const measurement = await this.readMeasurement(deployment.clientId);

    const instanceSummaries: PilotInstanceSummary[] = instances.map((instance) => ({
      workflowInstanceId: instance.workflowInstanceId,
      status: instance.status,
      terminal: isTerminalWorkflowInstanceStatus(instance.status),
      createdAt: instance.createdAt,
    }));

    return {
      deployment,
      goalStatus: goal.status,
      playbookVersionStatus: playbookVersion.status,
      workflowDefinitionStatus: definition.status,
      experimentStatus: experiment.status,
      experimentResultState: experiment.resultState,
      resultingDecision: experiment.resultingDecision,
      instances: instanceSummaries,
      liveInstanceCount: instanceSummaries.filter((summary) => !summary.terminal).length,
      measurement: measurement.evaluation,
    };
  }

  // -------------------------------------------------------------------------
  // CONCLUDE — the §16 decision through /experiments (running → analyzing
  // → concluded, citing same-Client evidence)
  // -------------------------------------------------------------------------

  /**
   * Concludes the pilot experiment: begin_analysis, then conclude with the
   * caller's result state, resulting decision, uncertainty interval
   * (matching the declared 'interval' representation), analysis metadata
   * and the cited /evidence records (SAME Client — the /experiments
   * authority validates every ref and surfaces a uniform NotFoundError for
   * foreign ids). The declared design is never rewritten; the conclusion
   * lands as one append-only transition row with server-derived provenance.
   */
  async concludeAcquisitionPilot(input: {
    readonly deployment: AcquisitionPilotDeployment;
    readonly conclusion: PilotConclusionInput;
    readonly actorId: string | null;
    readonly correlation: PilotCorrelationInput;
  }): Promise<ExperimentRecord> {
    let experiment = await this.deps.experiments.getExperiment(input.deployment.experimentId);
    if (experiment === null) {
      throw new NotFoundError('experiment', input.deployment.experimentId);
    }
    if (experiment.status === 'concluded') {
      throw new ConflictError(
        `experiment ${experiment.experimentId} is already concluded; concluded history is immutable`,
      );
    }
    if (experiment.status !== 'running' && experiment.status !== 'analyzing') {
      throw new ConflictError(
        `experiment ${experiment.experimentId} is ${experiment.status}; the pilot concludes from running (or analyzing)`,
      );
    }
    // FAIL CLOSED before begin_analysis: every cited evidence record must
    // resolve to an /evidence record of the SAME Client (uniform
    // NotFoundError otherwise — a foreign evidence id is not a traversal
    // oracle; the /experiments module fence and its DB trigger remain the
    // authoritative backstops, this composition-level check keeps the
    // pilot from leaving the experiment in analyzing on a bad citation).
    for (const evidenceRef of input.conclusion.evidenceRefs) {
      const evidence = await this.deps.evidence.getEvidence(evidenceRef);
      if (evidence === null || evidence.clientId !== input.deployment.clientId) {
        throw new NotFoundError('evidence', evidenceRef);
      }
    }
    if (experiment.status === 'running') {
      experiment = await this.deps.experiments.applyExperimentTransition(
        experiment.experimentId,
        { transition: 'begin_analysis', conclusion: null },
        this.experimentProvenance(input.correlation),
      );
    }
    return this.deps.experiments.applyExperimentTransition(
      experiment.experimentId,
      {
        transition: 'conclude',
        conclusion: {
          resultState: input.conclusion.resultState,
          uncertainty: {
            kind: 'interval',
            lower: input.conclusion.uncertaintyInterval.lower,
            upper: input.conclusion.uncertaintyInterval.upper,
            level: input.conclusion.uncertaintyInterval.level,
          },
          assumptions: input.conclusion.assumptions,
          sampleLimitations: input.conclusion.sampleLimitations,
          confounders: input.conclusion.confounders,
          resultingDecision: input.conclusion.resultingDecision,
          evidenceRefs: input.conclusion.evidenceRefs,
        },
      },
      this.experimentProvenance(input.correlation),
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Reads the client's /metrics observations and evaluates the template guardrails. */
  private async readMeasurement(clientId: string): Promise<PilotMeasurementRead> {
    const observations = await this.deps.metrics.listMetricObservationsForClient(clientId);
    return {
      evaluation: evaluatePilotGuardrails(observations.map(observationView), ACQUISITION_PILOT_BOUNDS),
      observationCount: observations.length,
    };
  }

  /** Server-derived experiment provenance (never caller input). */
  private experimentProvenance(correlation: PilotCorrelationInput): ExperimentProvenance {
    return {
      actor: 'service:acquisition-pilot',
      recordedVia: 'worker:acquisition-pilot',
      correlationId: correlation.correlationId,
      causationId: correlation.causationId,
    };
  }

  /** Server-derived evidence provenance (never caller input). */
  private evidenceProvenance(correlation: PilotCorrelationInput): EvidenceProvenance {
    return {
      actor: 'service:acquisition-pilot',
      recordedVia: 'worker:acquisition-pilot',
      correlationId: correlation.correlationId,
      causationId: correlation.causationId,
    };
  }
}
