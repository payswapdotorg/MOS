/**
 * MKT-034 — THE ACQUISITION LOOP WIRING (the composition glue that drives
 * the loop template through the authority public contracts — the
 * src/workers/acquisition-pilot/ MKT-028 precedent, widened by the three
 * execution legs of E2E-AC-01). This service is constructed by the
 * integration harness in-process through bootstrapApplication() against the
 * SAME real embedded PostgreSQL the API subprocess serves, while the
 * operational legs (the §18 offer/acceptance/visit/outcome chain, the
 * pooled dispatch + REAL worker subprocess, the HTTP evidence/metrics
 * appends, the MKT-032 extension portal chain and the Client Decision Room
 * read) are driven through the real HTTP API.
 *
 * AUTHORITY DISCIPLINE (the whole file — pinned by
 * tests/architecture/acquisition-loop-boundary.test.ts):
 *
 *   - composes ONLY the frozen module PUBLIC contracts
 *     (/goals, /playbooks, /workflows, /executions, /jobs, /evidence,
 *     /metrics, /experiments, /extensions, /ai-runtime, /learnings) — never
 *     module internals, never direct SQL, never the database, never a
 *     migration;
 *   - the loop owns NO durable state: every derived value is re-read from
 *     the authorities on every call (deploy/start/route/invoke/evaluate/
 *     status/conclude/learn are state-driven, exactly like the MKT-011
 *     pooled protocol and the MKT-028 pilot wiring);
 *   - every mutation goes through an authority's own mutation port
 *     (createGoal side: createClientPlaybook / createPlaybookVersion /
 *     setPlaybookVersionStatus / createWorkflow / createWorkflowDefinition /
 *     setWorkflowDefinitionStatus / createExperiment /
 *     applyExperimentTransition / createWorkflowInstance /
 *     transitionWorkflowInstance / createExecution / projectJob /
 *     appendEvidence / createLearning) plus the two DELEGATED execution
 *     ports the frozen contracts hand to callers — /ai-runtime routeTask
 *     (the caller-supplied provider adapter rides the ProviderAdapter port;
 *     the composition root wires the real one, the test harness a fake —
 *     the MKT-018 route contract) and /extensions beginExtensionInvocation
 *     (the §19 short-lived invocation context derivation) — the loop NEVER
 *     writes another authority's tables and NEVER commands a state an
 *     authority does not expose;
 *   - START IS FAIL-CLOSED: the five documented bounds are checked BEFORE
 *     any write happens (goal live, experiment not stopped, instance cap,
 *     live-instance cap, guardrails not breached);
 *   - STOP ONLY BLOCKS THE FUTURE: a stopped/invalidated/concluded
 *     experiment blocks new instance selection but rewrites nothing —
 *     recorded history stays byte-for-byte (append-only authorities);
 *   - a caller-supplied identifier is NEVER an authorization: every
 *     operation re-resolves canonical ownership through the authorities
 *     (resolveGoalOwnership; the TaskProfile workspace fence before
 *     routing) and surfaces uniform NotFoundErrors for foreign, unknown
 *     and orphaned identifiers alike.
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
import type {
  ExtensionInvocationContext,
  ExtensionInvocationProvenance,
  ExtensionsModuleApi,
} from '../../modules/extensions/public.ts';
import type {
  AiRuntimeModuleApi,
  CascadeValidator,
  ProviderAdapter,
  RoutingOutcome,
} from '../../modules/ai-runtime/public.ts';
import type { LearningProvenance, LearningRecord, LearningsModuleApi } from '../../modules/learnings/public.ts';
import type { WorkflowInstanceRecord } from '../../modules/workflows/public.ts';
import { isTerminalWorkflowInstanceStatus } from '../../modules/workflows/public.ts';
import {
  LOOP_AI_NODE,
  LOOP_EXTENSION_NODE,
  LOOP_FIELD_NODE,
  observationView,
  type AcquisitionLoopDeployment,
  type AcquisitionLoopStatus,
  type LoopConclusionInput,
  type LoopCorrelationInput,
  type LoopGuardrailEvaluation,
  type LoopInstanceSummary,
  type LoopLearningInput,
  type LoopLearningSummary,
} from './contract.ts';
import {
  ACQUISITION_LOOP_BOUNDS,
  acquisitionLoopTemplate,
  buildFieldJobDescriptor,
  evaluateLoopGuardrails,
} from './template.ts';

/** The composed authority set — the frozen module PUBLIC contracts only. */
export interface AcquisitionLoopDeps {
  readonly goals: GoalsModuleApi;
  readonly playbooks: PlaybooksModuleApi;
  readonly workflows: WorkflowsModuleApi;
  readonly executions: ExecutionsModuleApi;
  readonly jobs: JobsModuleApi;
  readonly evidence: EvidenceModuleApi;
  readonly metrics: MetricsModuleApi;
  readonly experiments: ExperimentsModuleApi;
  readonly extensions: ExtensionsModuleApi;
  readonly aiRuntime: AiRuntimeModuleApi;
  readonly learnings: LearningsModuleApi;
}

/** The derived measurement read: the evaluation plus the observations it consumed. */
export interface LoopMeasurementRead {
  readonly evaluation: LoopGuardrailEvaluation;
  readonly observationCount: number;
}

/**
 * THE ACQUISITION LOOP FLOW SERVICE — bounded composition over the frozen
 * authorities. Construct it anywhere the module publics are wired (the
 * composition root could hand it to a future entrypoint; the MKT-034 Work
 * Order sanctions test-harness wiring — the integration harness constructs
 * it in-process, exactly like the MKT-028 acquisition-pilot precedent).
 */
export class AcquisitionLoopFlow {
  private readonly deps: AcquisitionLoopDeps;

  constructor(deps: AcquisitionLoopDeps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // DEPLOY — Goal → Playbook Version (PUBLISHED) → Workflow Definition
  // (ACTIVE) → Experiment (DRAFT). All writes through the authority publics.
  // -------------------------------------------------------------------------

  /**
   * Deploys the acquisition loop template for one Goal:
   *
   *   1. FAIL CLOSED (before any write): the Goal resolves through /goals
   *      canonical ownership (null → uniform NotFoundError — a foreign goal
   *      id is indistinguishable from an unknown one); the Goal must be
   *      ACTIVE (a draft or terminal goal cannot operationalize a loop);
   *      the Goal must be WORKSPACE-SCOPED (the composed /workflows
   *      authority derives its client from the workspace chain — pinning
   *      the goal's own workspace guarantees the loop workflow lands in
   *      the SAME client as the goal).
   *   2. /playbooks.createClientPlaybook — the Client-scoped playbook with
   *      the immutable Goal link.
   *   3. /playbooks.createPlaybookVersion + setPlaybookVersionStatus
   *      (draft → review → published — the frozen editorial pipeline). The
   *      version's deployment metadata DECLARES the extension capability
   *      the §19 leg requires.
   *   4. /workflows.createWorkflow (in the goal's workspace) +
   *      createWorkflowDefinition (§4-validated three-leg template graph,
   *      pinned to the published playbook version) + setWorkflowDefinitionStatus
   *      (draft → review → active).
   *   5. /experiments.createExperiment — the full §16 declaration with
   *      server-derived provenance (DRAFT lifecycle start).
   *
   * Returns the deployment descriptor (the explicit authority-owned ids).
   */
  async deployAcquisitionLoop(input: {
    readonly goalId: string;
    readonly actorId: string | null;
    readonly correlation: LoopCorrelationInput;
  }): Promise<AcquisitionLoopDeployment> {
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
        `goal ${goal.goalId} is ${goal.status}; the acquisition loop deploys only on active goals`,
      );
    }
    if (goal.workspaceId === null) {
      throw new ConflictError(
        `goal ${goal.goalId} is client-wide; the acquisition loop requires a workspace-scoped goal so the composed workflow lands in the goal's own client`,
      );
    }
    // ---- writes through the authority publics ----------------------------

    const template = acquisitionLoopTemplate();

    const playbook = await this.deps.playbooks.createClientPlaybook({
      clientId: goal.clientId,
      goalId: goal.goalId,
      name: 'Acquisition loop (end-to-end operating loop)',
      description:
        'Bounded end-to-end acquisition loop: one AI-scored outreach execution, one field visit and one extension audience-sync action per instance under one workflow lifecycle, measured on qualified leads against a cost guardrail.',
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
      name: 'Acquisition loop flow',
      description:
        'End-to-end acquisition loop workflow: AI scoring (ai_task, AI Runtime routing) + field visit (human_task, §18) + audience sync (extension_capability, §19) joined into the loop outcome.',
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
  // START — one bounded loop instance. THE FIVE FAIL-CLOSED BOUNDS are
  // checked BEFORE any write (pinned by the static boundary test).
  // -------------------------------------------------------------------------

  /**
   * Starts ONE loop instance of a deployed loop. The five bounds, in
   * order, all BEFORE any write:
   *
   *   1. GOAL LIVE — the goal re-resolves through /goals canonical
   *      ownership and is still ACTIVE (a terminal or draft goal blocks
   *      new loop use);
   *   2. EXPERIMENT NOT STOPPED — the /experiments record re-reads and is
   *      in a startable state (draft/ready/running). A STOPPED, invalidated
   *      or concluded experiment blocks FUTURE instance selection only —
   *      recorded history is never rewritten (stop-only-future semantics);
   *   3. INSTANCE CAP — the total number of instances that EVER existed
   *      for the loop workflow (append-only history, terminal states
   *      included) is under bounds.maxInstancesPerLoop;
   *   4. LIVE-INSTANCE CAP — the number of NON-TERMINAL instances is under
   *      bounds.maxConcurrentInstances;
   *   5. GUARDRAILS NOT BREACHED — the pure evaluation over the client's
   *      /metrics observations (name+dimensions identity) shows no
   *      guardrail over its threshold. A breach BLOCKS new starts.
   *
   * Then (state-driven, convergent): the experiment is advanced to RUNNING
   * (draft → ready → running; already-running converges without re-applying),
   * the workflow instance is created through /workflows and staged
   * draft → ready → running with loop-scoped idempotency keys. The returned
   * instance is the SHARED lifecycle carrier of all three execution legs
   * (E2E-AC-01 "a shared Goal/Workflow/Evidence lifecycle").
   */
  async startLoopInstance(input: {
    readonly deployment: AcquisitionLoopDeployment;
    readonly actorId: string | null;
    readonly correlation: LoopCorrelationInput;
  }): Promise<{ instance: WorkflowInstanceRecord; experiment: ExperimentRecord }> {
    const deployment = input.deployment;
    const bounds = ACQUISITION_LOOP_BOUNDS;

    // ---- bound 1: the goal must still be live ----------------------------
    const ownership = await this.deps.goals.resolveGoalOwnership(deployment.goalId);
    if (ownership === null) {
      throw new NotFoundError('goal', deployment.goalId);
    }
    if (ownership.goal.status !== 'active') {
      throw new ConflictError(
        `goal ${deployment.goalId} is ${ownership.goal.status}; no new loop instance may start`,
      );
    }

    // ---- bound 2: a stopped experiment blocks future selection only ------
    const experiment = await this.deps.experiments.getExperiment(deployment.experimentId);
    if (experiment === null) {
      throw new NotFoundError('experiment', deployment.experimentId);
    }
    if (experiment.status === 'stopped' || experiment.status === 'invalidated' || experiment.status === 'concluded') {
      throw new ConflictError(
        `experiment ${deployment.experimentId} is ${experiment.status}; stopping blocks future loop instance selection only and never rewrites recorded history`,
      );
    }

    // ---- bound 3: the total instance budget ------------------------------
    const instances = await this.deps.workflows.listWorkflowInstances(deployment.workflowId);
    if (instances.length >= bounds.maxInstancesPerLoop) {
      throw new ConflictError(
        `loop workflow ${deployment.workflowId} already has ${instances.length} instances (append-only history, terminal included); the bounded loop allows at most ${bounds.maxInstancesPerLoop}`,
      );
    }

    // ---- bound 4: the live-instance cap ----------------------------------
    const liveCount = instances.filter((instance) => !isTerminalWorkflowInstanceStatus(instance.status)).length;
    if (liveCount >= bounds.maxConcurrentInstances) {
      throw new ConflictError(
        `loop workflow ${deployment.workflowId} already has ${liveCount} live (non-terminal) instances; the bounded loop allows at most ${bounds.maxConcurrentInstances} at a time`,
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
        `loop guardrail breached for client ${deployment.clientId}: ${breached}; no new loop instance may start`,
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
        idempotencyKey: `acquisition-loop:${instance.workflowInstanceId}:${to}`,
        reason: `acquisition loop instance ${to}`,
        actorId: input.actorId,
      });
      instance = outcome.instance;
    }

    return { instance, experiment: current };
  }

  // -------------------------------------------------------------------------
  // THE THREE EXECUTION LEGS — thin, bounded compositions over the runtime,
  // marketplace, extension and AI-routing authorities. All three legs carry
  // the SAME workflow-instance task linkage (the shared lifecycle).
  // -------------------------------------------------------------------------

  /**
   * Creates the AI leg execution: one /executions runtime attempt for the
   * template's `ai_task` node (AI execution kind, pooled-worker runtime
   * class), born CREATED with the caller's §8 logical idempotency key. The
   * AI RUNTIME routing itself is a separate hop (routeAiTask) — the
   * /ai-runtime authority routes the TaskProfile and runs the cheap-first
   * cascade; the execution lifecycle belongs to /executions alone.
   */
  async createAiTaskExecution(input: {
    readonly deployment: AcquisitionLoopDeployment;
    readonly workflowInstanceId: string;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<ExecutionCreateOutcome> {
    return this.deps.executions.createExecution({
      workspaceId: input.deployment.workspaceId,
      taskLink: {
        kind: 'workflow-node',
        workflowInstanceId: input.workflowInstanceId,
        nodeId: LOOP_AI_NODE,
      },
      retryOfExecutionId: null,
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
    });
  }

  /**
   * Routes the AI leg through the /ai-runtime authority (MKT-017/018):
   * applies the routing policy (or the default), runs the cheap-first
   * cascade with the caller-supplied provider adapter and validator (the
   * ProviderAdapter PORT — the composition root wires the real provider,
   * the test harness a fake — the frozen MKT-018 route contract), persists
   * the AUTHORITATIVE selection decision and cascade run and returns the
   * outcome.
   *
   * FAIL CLOSED before the routing write: the TaskProfile must resolve
   * through the /ai-runtime public contract AND belong to the SAME
   * Workspace as the deployment (uniform NotFoundError otherwise — a
   * foreign profile id is not a traversal oracle; the module's own
   * scope-chain fences are the authoritative backstops).
   */
  async routeAiTask(input: {
    readonly deployment: AcquisitionLoopDeployment;
    readonly taskProfileId: string;
    readonly adapter: ProviderAdapter;
    readonly validator: CascadeValidator;
    readonly invocationInput: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
    readonly correlation: LoopCorrelationInput;
  }): Promise<RoutingOutcome> {
    const profile = await this.deps.aiRuntime.getTaskProfile(input.taskProfileId);
    if (profile === null || profile.workspaceId !== input.deployment.workspaceId) {
      throw new NotFoundError('task-profile', input.taskProfileId);
    }
    return this.deps.aiRuntime.routeTask({
      workspaceId: profile.workspaceId,
      clientId: profile.clientId,
      agencyId: profile.agencyId,
      taskProfileId: profile.taskProfileId,
      routingPolicyId: null,
      adapter: input.adapter,
      validator: input.validator,
      invocationInput: input.invocationInput,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlation.correlationId,
      actorId: input.actorId,
    });
  }

  /**
   * Creates the EXTENSION leg execution: one /executions runtime attempt
   * for the template's `extension_capability` node (extension execution
   * kind, pooled-worker runtime class — the runtime contract extension
   * code executes under; /executions owns it). The §19 invocation-context
   * derivation (beginExtensionAction) is a separate hop through the
   * /extensions authority; the pooled dispatch is driven through the
   * runtime surface by the loop's callers.
   */
  async createExtensionExecution(input: {
    readonly deployment: AcquisitionLoopDeployment;
    readonly workflowInstanceId: string;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<ExecutionCreateOutcome> {
    return this.deps.executions.createExecution({
      workspaceId: input.deployment.workspaceId,
      taskLink: {
        kind: 'workflow-node',
        workflowInstanceId: input.workflowInstanceId,
        nodeId: LOOP_EXTENSION_NODE,
      },
      retryOfExecutionId: null,
      executionKind: 'extension',
      runtimeClass: 'pooled-worker',
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
    });
  }

  /**
   * Derives the §19 EXTENSION ACTION invocation context through the
   * /extensions public contract: beginExtensionInvocation resolves the
   * EXECUTION's canonical ownership server-side, requires the installed +
   * AUTHORIZED extension version of the execution's workspace, guards the
   * requested capabilities against the manifest, evaluates the
   * extension-dimension 'invoke' policy FAIL CLOSED and records the
   * short-lived context in the append-only ledger. The loop composes the
   * authority port — it never derives scope, capabilities or policy posture
   * itself.
   */
  async beginExtensionAction(input: {
    readonly executionId: string;
    readonly extensionId: string;
    readonly requestedCapabilities: readonly string[];
    readonly invocationInput: Readonly<Record<string, unknown>>;
    readonly correlation: LoopCorrelationInput;
  }): Promise<ExtensionInvocationContext> {
    return this.deps.extensions.beginExtensionInvocation(
      {
        executionId: input.executionId,
        extensionId: input.extensionId,
        requestedCapabilities: input.requestedCapabilities,
        input: input.invocationInput,
      },
      this.extensionProvenance(input.correlation),
    );
  }

  /**
   * Projects the FIELD leg job: the template's `human_task` node projected
   * into a §18 field Job with the template's public descriptor
   * (profile-data-only eligibility — NO Client data). The /jobs authority
   * re-validates the RUNNING instance + node class and derives the scope
   * chain server-side. Offers, acceptance, the visit lifecycle and the
   * structured outcome are driven through the /jobs surfaces (HTTP in the
   * E2E) — the loop composes the projection only.
   */
  async projectFieldJob(input: {
    readonly deployment: AcquisitionLoopDeployment;
    readonly workflowInstanceId: string;
    readonly actorId: string | null;
  }): Promise<JobRecord> {
    return this.deps.jobs.projectJob({
      workflowInstanceId: input.workflowInstanceId,
      nodeId: LOOP_FIELD_NODE,
      descriptor: buildFieldJobDescriptor(),
      actorId: input.actorId,
    });
  }

  // -------------------------------------------------------------------------
  // EVIDENCE — the shared lifecycle's /evidence appends (all three legs +
  // the commissioning-side loop outcome), through the /evidence public
  // -------------------------------------------------------------------------

  /**
   * Records one commissioning-side /evidence record of the loop: the
   * per-leg outcome facts (the AI routing output, the extension run
   * artifact, the field result summary) or the loop outcome facts, as an
   * observation or source_fact row of the goal's client, with
   * server-derived provenance. The experiment conclusion and the Learning
   * cite these records (same-Client, DB-fenced).
   */
  async recordLoopEvidence(input: {
    readonly deployment: AcquisitionLoopDeployment;
    readonly sourceRef: string;
    readonly evidenceClass: 'observation' | 'source_fact';
    readonly quality: 'B' | 'C';
    readonly observedAtIso: string;
    readonly content: Readonly<Record<string, unknown>>;
    readonly contentRef: string | null;
    readonly actorId: string | null;
    readonly correlation: LoopCorrelationInput;
  }): Promise<EvidenceRecord> {
    return this.deps.evidence.appendEvidence(
      {
        clientId: input.deployment.clientId,
        workspaceId: input.deployment.workspaceId,
        class: input.evidenceClass,
        source: { system: 'acquisition-loop', ref: input.sourceRef },
        observedAt: input.observedAtIso,
        content: input.content,
        contentRef: input.contentRef,
        quality: input.quality,
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
  async evaluateLoopGuardrails(clientId: string): Promise<LoopMeasurementRead> {
    return this.readMeasurement(clientId);
  }

  // -------------------------------------------------------------------------
  // CONCLUDE — the §16 decision through /experiments (running → analyzing
  // → concluded, citing same-Client evidence)
  // -------------------------------------------------------------------------

  /**
   * Concludes the loop experiment: begin_analysis, then conclude with the
   * caller's result state, resulting decision, uncertainty interval
   * (matching the declared 'interval' representation), analysis metadata
   * and the cited /evidence records (SAME Client — the /experiments
   * authority validates every ref and surfaces a uniform NotFoundError for
   * foreign ids). The declared design is never rewritten; the conclusion
   * lands as one append-only transition row with server-derived provenance.
   */
  async concludeLoopExperiment(input: {
    readonly deployment: AcquisitionLoopDeployment;
    readonly conclusion: LoopConclusionInput;
    readonly actorId: string | null;
    readonly correlation: LoopCorrelationInput;
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
        `experiment ${experiment.experimentId} is ${experiment.status}; the loop concludes from running (or analyzing)`,
      );
    }
    // FAIL CLOSED before begin_analysis: every cited evidence record must
    // resolve to an /evidence record of the SAME Client (uniform
    // NotFoundError otherwise — a foreign evidence id is not a traversal
    // oracle; the /experiments module fence and its DB trigger remain the
    // authoritative backstops, this composition-level check keeps the
    // loop from leaving the experiment in analyzing on a bad citation).
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
  // LEARN — the §17 Learning append through /learnings (the final hop of
  // the operating loop, citing same-Client evidence + a CONCLUDED experiment)
  // -------------------------------------------------------------------------

  /**
   * Appends the loop's Learning through the /learnings public contract:
   * the durable conclusion statement with its explicit applicability
   * conditions, citing the same-Client /evidence records and the CONCLUDED
   * /experiments outcome (the /learnings authority validates every
   * reference fail-closed — foreign evidence ids are uniform 404s; a
   * non-concluded experiment reference is rejected before any write).
   * Provenance is server-derived; the record is immutable from birth.
   */
  async recordLoopLearning(input: {
    readonly deployment: AcquisitionLoopDeployment;
    readonly learning: LoopLearningInput;
    readonly actorId: string | null;
    readonly correlation: LoopCorrelationInput;
  }): Promise<LearningRecord> {
    return this.deps.learnings.createLearning(
      {
        clientId: input.deployment.clientId,
        workspaceId: input.deployment.workspaceId,
        statement: input.learning.statement,
        applicability: input.learning.applicability,
        evidenceRefs: input.learning.evidenceRefs,
        experimentRefs: input.learning.experimentRefs,
        confidence: input.learning.confidence,
      },
      this.learningProvenance(input.correlation),
    );
  }

  // -------------------------------------------------------------------------
  // STATUS — the fully derived snapshot (the loop owns NO state)
  // -------------------------------------------------------------------------

  /**
   * The DERIVED loop status: goal, playbook version, workflow definition,
   * experiment (status + result state + resulting decision), every instance
   * (with terminal flags), the live count, the client's Learning ledger and
   * the guardrail evaluation — each field re-read from its authority at
   * call time.
   */
  async getLoopStatus(deployment: AcquisitionLoopDeployment): Promise<AcquisitionLoopStatus> {
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
    const learningRecords = await this.deps.learnings.listLearningsForClient(deployment.clientId);

    const instanceSummaries: LoopInstanceSummary[] = instances.map((instance) => ({
      workflowInstanceId: instance.workflowInstanceId,
      status: instance.status,
      terminal: isTerminalWorkflowInstanceStatus(instance.status),
      createdAt: instance.createdAt,
    }));

    const learningSummaries: LoopLearningSummary[] = learningRecords.map((record) => ({
      learningId: record.learningId,
      status: record.status,
      statement: record.statement,
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
      learnings: learningSummaries,
      measurement: measurement.evaluation,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Reads the client's /metrics observations and evaluates the template guardrails. */
  private async readMeasurement(clientId: string): Promise<LoopMeasurementRead> {
    const observations = await this.deps.metrics.listMetricObservationsForClient(clientId);
    return {
      evaluation: evaluateLoopGuardrails(observations.map(observationView), ACQUISITION_LOOP_BOUNDS),
      observationCount: observations.length,
    };
  }

  /** Server-derived experiment provenance (never caller input). */
  private experimentProvenance(correlation: LoopCorrelationInput): ExperimentProvenance {
    return {
      actor: 'service:acquisition-loop',
      recordedVia: 'worker:acquisition-loop',
      correlationId: correlation.correlationId,
      causationId: correlation.causationId,
    };
  }

  /** Server-derived evidence provenance (never caller input). */
  private evidenceProvenance(correlation: LoopCorrelationInput): EvidenceProvenance {
    return {
      actor: 'service:acquisition-loop',
      recordedVia: 'worker:acquisition-loop',
      correlationId: correlation.correlationId,
      causationId: correlation.causationId,
    };
  }

  /** Server-derived extension invocation provenance (never caller input). */
  private extensionProvenance(correlation: LoopCorrelationInput): ExtensionInvocationProvenance {
    return {
      actor: 'service:acquisition-loop',
      recordedVia: 'worker:acquisition-loop',
      correlationId: correlation.correlationId,
      causationId: correlation.causationId,
    };
  }

  /** Server-derived learning provenance (never caller input). */
  private learningProvenance(correlation: LoopCorrelationInput): LearningProvenance {
    return {
      actor: 'service:acquisition-loop',
      recordedVia: 'worker:acquisition-loop',
      correlationId: correlation.correlationId,
      causationId: correlation.causationId,
    };
  }
}
