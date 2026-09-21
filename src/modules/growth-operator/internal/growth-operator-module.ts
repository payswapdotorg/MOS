/**
 * /growth-operator module implementation (MKT-054).
 *
 * THE PERSISTENT GOAL-PURSUIT CONTROLLER. Owns the migration 050 tables:
 * one controller per mission, the bounded plan steps with their
 * deterministic idempotency keys, the append-only decision tail and the
 * append-only state-transition audit trail.
 *
 * THE CARDINAL RULE (architecture-lock-v1.6.md rule 17): this module
 * contains NO job pickup, NO execution lifecycle mutation, NO sandbox
 * leasing, NO dispatch/queue submit and NO worker pool. ALL physical work
 * flows through the EXISTING /workflows and /executions authorities via
 * their public commands: the delegated experiment is declared through
 * /experiments; the strategic replan decision lands in the /decisions
 * ledger; the workflow container/definition/instance are created and
 * transitioned through /workflows' own commands; the execution is created
 * through /executions (born 'created' — the RUNTIME PLANE owns its
 * lifecycle) and only ever READ afterwards. The operator OBSERVES outcomes
 * through the authorities' public read surfaces and records them as
 * /evidence observations.
 *
 * RESTART-SAFETY: every delegation sequence is convergent. The plan step
 * row is the write-ahead record (inserted 'planned' BEFORE any authority
 * call), each authority object converges through its own fence (the §8
 * execution idempotency key, the per-instance transition keys, the
 * per-client decision idempotency key) or through deterministic
 * find-or-create (the pursuit workflow by its deterministic name; the
 * step definition by its step-derived node id; the step instance by its
 * pinned definition; the step experiment by its step-tagged hypothesis),
 * and every obtained reference is recorded back on the step row
 * immediately. A crash at ANY point leaves a 'planned' step the next tick
 * re-drives to completion — never a double-dispatch (the DB UNIQUE
 * (mission_id, idempotency_key) fence converges the replan itself).
 *
 * Concurrency: every state mutation is a row-locked CAS transaction
 * (SELECT ... FOR UPDATE + explicit version check). Authorization derives
 * from durable state on every call — no process-local cache authority.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { GrowthMissionStatus } from '../../growth-missions/public.ts';
import type { WorkflowDefinitionContent } from '../../workflows/public.ts';
import type {
  GrowthOperatorControllerDetail,
  GrowthOperatorControllerRecord,
  GrowthOperatorControllerStatus,
  GrowthOperatorDecisionRecord,
  GrowthOperatorEventRecord,
  GrowthOperatorModuleApi,
  GrowthOperatorModuleDeps,
  GrowthOperatorObservedOutcome,
  GrowthOperatorPlanStepRecord,
  GrowthOperatorDecisionKind,
  GrowthOperatorProvenance,
  GrowthOperatorTerminalCause,
  GrowthOperatorTreatmentFamily,
} from '../public.ts';
import type { GrowthOperatorDelegationGatePort } from '../public.ts';
import { GROWTH_OPERATOR_STRATEGY_VERSION } from '../public.ts';
import {
  GROWTH_OPERATOR_DEFAULT_BUDGET,
  computePlanStepIdempotencyKey,
  computeEvidenceSnapshotDigest,
  selectNextTreatment,
} from './strategy-space.ts';
import {
  GrowthOperatorStore,
  assertValidGrowthOperatorProvenance,
  assertValidGrowthOperatorReason,
} from './growth-operator-store.ts';

/** The terminal mission-machine statuses (MKT-053's §2 terminal list). */
const MISSION_TERMINAL_STATUSES = new Set<GrowthMissionStatus>([
  'achieved',
  'stopped_by_user',
  'blocked_pending_human_action',
  'blocked_by_unavailable_capability',
  'budget_quota_exhausted',
  'policy_constrained',
  'failed_after_bounded_recovery',
]);

/** The non-terminal mission statuses where pursuit can run. */
const MISSION_ACTIVE = 'active';
const MISSION_PAUSED = 'paused';

/** The delegated workflow-instance terminal statuses (the §5 machine). */
const INSTANCE_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export function createGrowthOperatorModule(deps: GrowthOperatorModuleDeps): GrowthOperatorModuleApi {
  const store = new GrowthOperatorStore(deps.db, deps.clock, deps.ids);
  const { clock, missions, workspaces, workflows, executions, evidence, learnings } = deps;
  const delegationGate: GrowthOperatorDelegationGatePort =
    deps.delegationGate ?? policiesComposedGate(deps.policies);

  return {
    async initializeController(input, provenance) {
      assertValidGrowthOperatorProvenance(provenance);

      // CANONICAL mission resolution from durable state BEFORE any write:
      // unknown mission → the uniform 404.
      const mission = await missions.getGrowthMission(input.missionId);
      if (mission === null) {
        throw new NotFoundError('growth mission', input.missionId);
      }
      // A terminal mission's history is frozen — no new pursuit starts on it.
      if (MISSION_TERMINAL_STATUSES.has(mission.status)) {
        throw new ConflictError(
          `mission ${input.missionId} is ${mission.status} and frozen; a controller cannot be initialized on a terminal mission`,
        );
      }
      // The measurable anchor: at least one ACTIVE goal mapping (the mission
      // authority itself enforces this on activation; the controller
      // requires it before any pursuit).
      const detail = await missions.getGrowthMissionDetail(input.missionId);
      if (detail === null) {
        throw new NotFoundError('growth mission', input.missionId);
      }
      const activeMappings = detail.goalMappings.filter((mapping) => mapping.removedAt === null);
      if (activeMappings.length === 0) {
        throw new ConflictError(
          `mission ${input.missionId} has no active goal mapping — the controller requires the measurable anchor before pursuit`,
        );
      }

      // THE PURSUIT SCOPE: canonical workspace ownership resolution BEFORE
      // any write. Unknown/tombstoned → the uniform 404; disabled →
      // ConflictError (new use blocked without rewriting history); a
      // workspace of ANOTHER agency is indistinguishable from an unknown
      // one (never a cross-tenant existence oracle).
      const workspace = await workspaces.resolveWorkspace(input.pursuitWorkspaceId);
      if (workspace === null || workspace.agencyId !== mission.agencyId) {
        throw new NotFoundError('workspace', input.pursuitWorkspaceId);
      }
      if (workspace.status !== 'active') {
        throw new ConflictError(
          `workspace ${input.pursuitWorkspaceId} is ${workspace.status}; the pursuit scope must be an active workspace of the mission's agency`,
        );
      }

      // ONE controller per mission (the DB UNIQUE fence is the backstop).
      const existing = await store.getController(input.missionId);
      if (existing !== null) {
        throw new ConflictError(
          `mission ${input.missionId} already has a growth operator controller (${existing.controllerId})`,
        );
      }

      const budget = { ...GROWTH_OPERATOR_DEFAULT_BUDGET, ...(input.budget ?? {}) };
      if (
        !Number.isInteger(budget.maxInFlightSteps) ||
        budget.maxInFlightSteps < 1 ||
        budget.maxInFlightSteps > 5
      ) {
        throw new InvalidRequestError('Invalid growth operator budget', [
          'budget.maxInFlightSteps: must be an integer between 1 and 5 (the bounded in-flight delegation concurrency)',
        ]);
      }
      if (
        budget.maxDelegatedSteps !== null &&
        (!Number.isInteger(budget.maxDelegatedSteps) || budget.maxDelegatedSteps < 1)
      ) {
        throw new InvalidRequestError('Invalid growth operator budget', [
          'budget.maxDelegatedSteps: null (unlimited) or a positive integer (the total delegation budget)',
        ]);
      }
      if (
        !Number.isInteger(budget.humanAmplificationBudget) ||
        budget.humanAmplificationBudget < 0 ||
        !Number.isInteger(budget.humanAmplificationEligibleCapacity) ||
        budget.humanAmplificationEligibleCapacity < 0
      ) {
        throw new InvalidRequestError('Invalid growth operator budget', [
          'budget.humanAmplificationBudget / budget.humanAmplificationEligibleCapacity: non-negative integers (the OPTIONAL human arm — zero by default)',
        ]);
      }

      const controllerId = deps.ids.newId();
      const now = clock.nowIso();
      await deps.db.transaction(async (tx) => {
        await store.insertController({
          controllerId,
          missionId: input.missionId,
          agencyId: mission.agencyId,
          pursuitClientId: workspace.clientId,
          pursuitWorkspaceId: workspace.workspaceId,
          budget,
          createdActor: provenance.actor,
          now,
        });
        // The initialization event: born running (the DB pair trigger
        // requires the init event to be event 1 with from_status NULL).
        await store.appendEvent(tx, {
          controllerId,
          missionId: input.missionId,
          fromStatus: null,
          toStatus: 'running',
          terminalCause: null,
          blockedGateKind: null,
          reason: 'growth operator controller initialized for pursuit',
          provenance,
        });
        await store.appendDecision(tx, {
          controllerId,
          missionId: input.missionId,
          decisionKind: 'controller_initialized',
          treatmentFamily: null,
          rationale: `Persistent pursuit controller initialized (strategy ${GROWTH_OPERATOR_STRATEGY_VERSION_REF}) in workspace ${workspace.workspaceId} of client ${workspace.clientId}`,
          evidenceRefs: [],
          detail: {
            pursuitWorkspaceId: workspace.workspaceId,
            pursuitClientId: workspace.clientId,
            budget,
            activeGoalIds: activeMappings.map((mapping) => mapping.goalId),
          },
          provenance,
        });
      });

      // The mission is ACTIVATED through the mission authority's own
      // command (draft → active, or resumed from paused). A mission that is
      // already active needs no transition.
      if (mission.status !== MISSION_ACTIVE) {
        await missions.setGrowthMissionStatus(
          {
            missionId: input.missionId,
            status: MISSION_ACTIVE,
            reason: 'growth operator controller initialized — mission pursuit activated',
            expectedVersion: mission.version,
          },
          provenance,
        );
      }

      return await detailOrThrow(input.missionId);
    },

    async pursueMission(input, provenance) {
      assertValidGrowthOperatorProvenance(provenance);
      const controller = await requireController(input.missionId);

      // 1. TERMINAL — the honest no-op (nothing runs after a terminal state).
      if (isTerminal(controller.status)) {
        return { controller, reconciledSteps: [], dispatchedStep: null, terminated: false, decisions: [], events: [] };
      }
      // 2. PAUSED — the deliberate stop (no work while paused).
      if (controller.status === 'paused') {
        return { controller, reconciledSteps: [], dispatchedStep: null, terminated: false, decisions: [], events: [] };
      }
      // 3. BLOCKED — the human action is still pending.
      if (controller.status === 'blocked_pending_human_action') {
        return { controller, reconciledSteps: [], dispatchedStep: null, terminated: false, decisions: [], events: [] };
      }

      const appendedDecisions: GrowthOperatorDecisionRecord[] = [];
      const appendedEvents: GrowthOperatorEventRecord[] = [];

      // ---------------------------------------------------------------------
      // 4. RECONCILE (restart-safety) — the mission state first.
      // ---------------------------------------------------------------------
      const mission = await missions.getGrowthMission(input.missionId);
      if (mission === null) {
        throw new NotFoundError('growth mission', input.missionId);
      }
      if (MISSION_TERMINAL_STATUSES.has(mission.status)) {
        const outcome = await terminateController(store, deps, controller, {
          terminalCause: 'mission_already_terminal',
          missionTerminalStatus: null, // the mission is ALREADY terminal — nothing to record there
          reason: `mission ${input.missionId} is already ${mission.status} (terminal) — the controller records the honest end and stops`,
        }, provenance);
        appendedDecisions.push(...outcome.decisions);
        appendedEvents.push(...outcome.events);
        return { controller: outcome.controller, reconciledSteps: [], dispatchedStep: null, terminated: true, decisions: appendedDecisions, events: appendedEvents };
      }
      if (mission.status === MISSION_PAUSED) {
        // The mission was deliberately paused out-of-band: the operator
        // DEFERS to the mission record (the conservative, honest choice).
        const outcome = await transitionController(store, deps, controller, {
          to: 'paused',
          reason: `mission ${input.missionId} was paused out-of-band — the controller defers to the mission record`,
          blockedGateKind: null,
          terminalCause: null,
        }, provenance);
        appendedDecisions.push(...outcome.decisions);
        appendedEvents.push(...outcome.events);
        return { controller: outcome.controller, reconciledSteps: [], dispatchedStep: null, terminated: false, decisions: appendedDecisions, events: appendedEvents };
      }

      const detail = await missions.getGrowthMissionDetail(input.missionId);
      if (detail === null) {
        throw new NotFoundError('growth mission', input.missionId);
      }
      const activeMappings = detail.goalMappings.filter((mapping) => mapping.removedAt === null);

      // A mission that lost every active goal mapping has no measurable
      // anchor — the honest terminal recording.
      if (activeMappings.length === 0) {
        const outcome = await terminateController(store, deps, controller, {
          terminalCause: 'no_delegable_treatment',
          missionTerminalStatus: 'blocked_by_unavailable_capability',
          reason: 'the mission has no active goal mapping left — the measurable anchor is gone and the pursuit cannot continue',
          mission,
        }, provenance);
        appendedDecisions.push(...outcome.decisions);
        appendedEvents.push(...outcome.events);
        return { controller: outcome.controller, reconciledSteps: [], dispatchedStep: null, terminated: true, decisions: appendedDecisions, events: appendedEvents };
      }

      // The in-flight steps (a crash window leaves 'planned' steps; the
      // reconcile drives them to completion convergently).
      let steps = await store.listPlanSteps(input.missionId);
      const reconciledSteps: { stepId: string; outcome: GrowthOperatorObservedOutcome | null; observationEvidenceId: string | null }[] = [];

      for (const step of steps.filter((candidate) => candidate.state === 'planned')) {
        // Re-drive the recorded plan's delegation (the gate already
        // allowed it when the step was planned — disclosed in the runbook).
        const driven = await driveDelegation(store, deps, controller, step, provenance);
        steps = steps.map((candidate) => (candidate.stepId === driven.stepId ? driven : candidate));
      }

      for (const step of steps.filter((candidate) => candidate.state === 'dispatched')) {
        const instance =
          step.workflowInstanceId === null
            ? null
            : await workflows.getWorkflowInstance(step.workflowInstanceId);
        const instanceStatus = instance?.status ?? 'unresolvable';
        if (INSTANCE_TERMINAL_STATUSES.has(instanceStatus) || instanceStatus === 'unresolvable') {
          const outcome: GrowthOperatorObservedOutcome =
            instanceStatus === 'succeeded'
              ? 'delegated_work_succeeded'
              : instanceStatus === 'cancelled'
                ? 'delegated_work_cancelled'
                : 'delegated_work_failed';
          const execution =
            step.executionId === null ? null : await executions.getExecution(step.executionId);
          // The observation lands as /evidence through the authority — the
          // delegated outcome is an honest system observation.
          const evidenceRecord = await evidence.appendEvidence(
            {
              clientId: controller.pursuitClientId,
              workspaceId: controller.pursuitWorkspaceId,
              class: 'observation',
              source: { system: 'growth-operator', ref: step.workflowInstanceId },
              observedAt: clock.nowIso(),
              content: {
                observation_kind: 'delegated_work_outcome',
                mission_id: controller.missionId,
                step_id: step.stepId,
                treatment_family: step.treatmentFamily,
                workflow_instance_id: step.workflowInstanceId,
                workflow_instance_status: instanceStatus,
                execution_id: step.executionId,
                execution_status: execution?.status ?? null,
                observed_outcome: outcome,
              },
              contentRef: null,
              quality: 'C',
              confidence: null,
              supersedesEvidenceId: null,
            },
            provenance,
          );
          const observedAt = clock.nowIso();
          let observationDecision: GrowthOperatorDecisionRecord | null = null;
          await deps.db.transaction(async (tx) => {
            const result = await store.markPlanStepObserved(tx, {
              stepId: step.stepId,
              observedOutcome: outcome,
              observationEvidenceId: evidenceRecord.evidenceId,
              observedAt,
              expectedVersion: step.version,
            });
            if (result !== 'ok') {
              throw new ConflictError(
                `plan step ${step.stepId} could not be observed (state race — re-run the tick)`,
              );
            }
            observationDecision = await store.appendDecision(tx, {
              controllerId: controller.controllerId,
              missionId: controller.missionId,
              decisionKind: 'observation',
              treatmentFamily: step.treatmentFamily,
              rationale: `Delegated work of step ${step.stepSeq} (${step.treatmentFamily}) reached '${instanceStatus}' on the workflow authority; execution status '${execution?.status ?? 'unresolvable'}'. Recorded as honest observation evidence.`,
              evidenceRefs: evidenceRecord.evidenceId === null ? [] : [evidenceRecord.evidenceId],
              detail: {
                stepId: step.stepId,
                workflowInstanceId: step.workflowInstanceId,
                workflowInstanceStatus: instanceStatus,
                executionId: step.executionId,
                executionStatus: execution?.status ?? null,
                observedOutcome: outcome,
              },
              provenance,
            });
          });
          reconciledSteps.push({
            stepId: step.stepId,
            outcome,
            observationEvidenceId: evidenceRecord.evidenceId,
          });
          if (observationDecision !== null) {
            appendedDecisions.push(observationDecision);
          }
        }
      }

      steps = await store.listPlanSteps(input.missionId);
      const inFlight = steps.filter((step) => step.state === 'dispatched').length;

      // ---------------------------------------------------------------------
      // 5. REPLAN (only when the bounded in-flight budget has room).
      // ---------------------------------------------------------------------
      if (inFlight >= controller.budget.maxInFlightSteps) {
        return {
          controller,
          reconciledSteps,
          dispatchedStep: null,
          terminated: false,
          decisions: appendedDecisions,
          events: appendedEvents,
        };
      }

      // The achievement check: ALL actively-mapped goals achieved (and at
      // least one) — the terminal decision is evaluated against the Goal
      // authority's own live statuses (the measurable anchor).
      const goalStatuses = activeMappings.map((mapping) => mapping.goalStatus ?? 'unresolvable');
      if (goalStatuses.length > 0 && goalStatuses.every((status) => status === 'achieved')) {
        const outcome = await terminateController(store, deps, controller, {
          terminalCause: 'goal_achieved',
          missionTerminalStatus: 'achieved',
          reason: `every actively-mapped goal of mission ${input.missionId} is achieved — the declared business outcome is reached`,
          mission,
        }, provenance);
        appendedDecisions.push(...outcome.decisions);
        appendedEvents.push(...outcome.events);
        return { controller: outcome.controller, reconciledSteps, dispatchedStep: null, terminated: true, decisions: appendedDecisions, events: appendedEvents };
      }

      // The budget/quota exhaustion check: a truthful terminal input,
      // never a fabricated success.
      const dispatchedCount = steps.filter((step) => step.state === 'dispatched' || step.state === 'observed').length;
      if (
        controller.budget.maxDelegatedSteps !== null &&
        dispatchedCount >= controller.budget.maxDelegatedSteps
      ) {
        const outcome = await terminateController(store, deps, controller, {
          terminalCause: 'delegation_budget_exhausted',
          missionTerminalStatus: 'budget_quota_exhausted',
          reason: `the delegation budget is exhausted (${dispatchedCount} delegated steps; the bound is ${controller.budget.maxDelegatedSteps}) and the goal is not achieved — the honest end`,
          mission,
        }, provenance);
        appendedDecisions.push(...outcome.decisions);
        appendedEvents.push(...outcome.events);
        return { controller: outcome.controller, reconciledSteps, dispatchedStep: null, terminated: true, decisions: appendedDecisions, events: appendedEvents };
      }

      // The evidence snapshot (the idempotent-replanning anchor).
      const evidenceRecords = await evidence.listEvidenceForClient(controller.pursuitClientId);
      const learningRecords = await learnings.listLearningsForClient(controller.pursuitClientId);
      const familyDispatchCounts: Record<string, number> = {};
      const familyLastOutcomes: Record<string, string> = {};
      for (const step of steps) {
        if (step.state === 'dispatched' || step.state === 'observed') {
          familyDispatchCounts[step.treatmentFamily] = (familyDispatchCounts[step.treatmentFamily] ?? 0) + 1;
        }
        if (step.state === 'observed' && step.observedOutcome !== null) {
          familyLastOutcomes[step.treatmentFamily] = step.observedOutcome;
        }
      }
      const digest = computeEvidenceSnapshotDigest({
        missionVersionSeq: mission.currentVersionSeq,
        goalStatuses,
        evidenceIds: evidenceRecords.map((record) => record.evidenceId),
        learningIds: learningRecords.map((record) => record.learningId),
        dispatchedStepCount: dispatchedCount,
        familyDispatchCounts,
        familyLastOutcomes,
        budget: controller.budget,
      });

      // IDEMPOTENT REPLAN: the same mission state + evidence snapshot → the
      // same deterministic step. A concurrent tick that already inserted it
      // converges here (the replay is the honest no-op).
      const nextStepSeq = steps.length + 1;
      const idempotencyKey = computePlanStepIdempotencyKey(digest, nextStepSeq);
      const existingStep = await deps.db.transaction(async (tx) =>
        store.findPlanStepByIdempotencyKey(tx, input.missionId, idempotencyKey),
      );
      if (existingStep !== null) {
        if (existingStep.state === 'planned') {
          const driven = await driveDelegation(store, deps, controller, existingStep, provenance);
          return {
            controller,
            reconciledSteps,
            dispatchedStep: driven,
            terminated: false,
            decisions: appendedDecisions,
            events: appendedEvents,
          };
        }
        // Already dispatched/observed/superseded: the replay no-op.
        return {
          controller,
          reconciledSteps,
          dispatchedStep: null,
          terminated: false,
          decisions: appendedDecisions,
          events: appendedEvents,
        };
      }

      // The bounded selection (pure, deterministic, versioned).
      const selection = selectNextTreatment({
        objectiveFamily: detail.currentVersion.objectiveFamily,
        missionObjective: detail.currentVersion.objective,
        budget: controller.budget,
        familyDispatchCounts,
        familyLastOutcomes,
        dispatchedStepCount: dispatchedCount,
      });

      // ---------------------------------------------------------------------
      // THE GATE WALK: only an explicit allow delegates. A genuine
      // rights/policy/capability gate blocks truthfully; a plain deny
      // skips to the next family; no allow at all terminates honestly.
      // ---------------------------------------------------------------------
      let selectedFamily: GrowthOperatorTreatmentFamily | null = null;
      const deniedFamilies: { family: GrowthOperatorTreatmentFamily; reason: string; policyDecisionRef: string | null }[] = [];
      for (const candidate of selection.candidates) {
        if (!candidate.delegable) continue; // the human arm is never delegated by MKT-054
        const gate = await delegationGate.evaluateDelegation(
          {
            missionId: controller.missionId,
            treatmentFamily: candidate.family,
            actionSummary: `growth-operator delegation of treatment '${candidate.family}' for mission ${controller.missionId}`,
            agencyId: controller.agencyId,
            clientId: controller.pursuitClientId,
          },
          provenance,
        );
        if (gate.outcome === 'allow') {
          selectedFamily = candidate.family;
          break;
        }
        if (gate.outcome === 'deny_pending_human_action') {
          const outcome = await transitionController(store, deps, controller, {
            to: 'blocked_pending_human_action',
            reason: `Delegation of treatment '${candidate.family}' gated: ${gate.reason}` +
              (gate.policyDecisionRef === null ? '' : ` (policy decision ${gate.policyDecisionRef})`),
            blockedGateKind: gate.gateKind ?? 'policy',
            terminalCause: null,
          }, provenance, {
            decisionKind: 'gate_encountered',
            treatmentFamily: candidate.family,
            rationale: `A genuine ${gate.gateKind ?? 'policy'} gate requires human action before treatment '${candidate.family}' can be delegated: ${gate.reason}`,
            detail: {
              treatmentFamily: candidate.family,
              gateKind: gate.gateKind ?? 'policy',
              policyDecisionRef: gate.policyDecisionRef,
              outcome: gate.outcome,
            },
          });
          appendedDecisions.push(...outcome.decisions);
          appendedEvents.push(...outcome.events);
          return {
            controller: outcome.controller,
            reconciledSteps,
            dispatchedStep: null,
            terminated: false,
            decisions: appendedDecisions,
            events: appendedEvents,
          };
        }
        deniedFamilies.push({
          family: candidate.family,
          reason: gate.reason,
          policyDecisionRef: gate.policyDecisionRef,
        });
        // Each fail-closed skip is recorded the moment it happens (the
        // honest gate trail — even when a later candidate blocks).
        appendedDecisions.push(
          await deps.db.transaction(async (tx) =>
            store.appendDecision(tx, {
              controllerId: controller.controllerId,
              missionId: controller.missionId,
              decisionKind: 'gate_encountered',
              treatmentFamily: candidate.family,
              rationale: `Delegation of treatment '${candidate.family}' was denied by the gate (fail-closed skip): ${gate.reason}`,
              evidenceRefs: [],
              detail: {
                treatmentFamily: candidate.family,
                outcome: 'deny',
                policyDecisionRef: gate.policyDecisionRef,
              },
              provenance,
            }),
          ),
        );
      }
      if (selectedFamily === null) {
        const outcome = await terminateController(store, deps, controller, {
          terminalCause: 'policy_denied_no_alternative',
          missionTerminalStatus: 'policy_constrained',
          reason:
            `every delegable treatment family was denied by the gate ` +
            `(${deniedFamilies.map((denied) => `${denied.family}: ${denied.reason}`).join('; ')}) — no compliant next action exists`,
          mission,
        }, provenance);
        appendedDecisions.push(...outcome.decisions);
        appendedEvents.push(...outcome.events);
        return { controller: outcome.controller, reconciledSteps, dispatchedStep: null, terminated: true, decisions: appendedDecisions, events: appendedEvents };
      }

      // ---------------------------------------------------------------------
      // THE PLAN INSERT (the write-ahead record) + the replan decision.
      // ---------------------------------------------------------------------
      const stepId = deps.ids.newId();
      const replanDecision = await deps.db.transaction(async (tx) => {
        const current = await store.lockController(tx, controller.missionId);
        if (current === null || current.status !== 'running') {
          throw new ConflictError(
            `controller of mission ${controller.missionId} is no longer running — re-run the tick`,
          );
        }
        await store.insertPlanStep(tx, {
          stepId,
          controllerId: controller.controllerId,
          missionId: controller.missionId,
          stepSeq: nextStepSeq,
          idempotencyKey,
          treatmentFamily: selectedFamily!,
          rationale: selection.rationale,
          evidenceSnapshotDigest: digest,
          evidenceRefs: [],
          consideredHuman: selection.consideredHuman,
          createdActor: provenance.actor,
          now: clock.nowIso(),
        });
        return await store.appendDecision(tx, {
          controllerId: controller.controllerId,
          missionId: controller.missionId,
          decisionKind: 'replan',
          treatmentFamily: selectedFamily!,
          rationale: selection.rationale,
          evidenceRefs: [],
          detail: {
            stepId,
            stepSeq: nextStepSeq,
            idempotencyKey,
            evidenceSnapshotDigest: digest,
            strategyVersion: controller.strategyVersion,
            selectedFamily: selectedFamily!,
            candidates: selection.candidates,
            consideredHuman: selection.consideredHuman,
            reallocatedFromHuman: selection.reallocatedFromHuman,
            deniedFamilies,
          },
          provenance,
        });
      });
      appendedDecisions.push(replanDecision);

      // ---------------------------------------------------------------------
      // THE DELEGATION — all physical work through the EXISTING
      // authorities. The step row is the write-ahead record; every
      // authority object converges (idempotency keys / deterministic
      // find-or-create).
      // ---------------------------------------------------------------------
      const planStep = (await store.listPlanSteps(controller.missionId)).find((step) => step.stepId === stepId)!;
      const delegated = await driveDelegation(store, deps, controller, planStep, provenance);

      const delegationDecision = await deps.db.transaction(async (tx) =>
        store.appendDecision(tx, {
          controllerId: controller.controllerId,
          missionId: controller.missionId,
          decisionKind: 'delegation',
          treatmentFamily: delegated.treatmentFamily,
          rationale: `Plan step ${delegated.stepSeq} delegated through the existing Workflow/Execution authorities: experiment ${delegated.experimentId}, decision ${delegated.decisionId}, workflow instance ${delegated.workflowInstanceId}, execution ${delegated.executionId}. The runtime plane owns the execution lifecycle.`,
          evidenceRefs: [],
          detail: {
            stepId: delegated.stepId,
            experimentId: delegated.experimentId,
            decisionId: delegated.decisionId,
            workflowId: delegated.workflowId,
            workflowDefinitionId: delegated.workflowDefinitionId,
            workflowInstanceId: delegated.workflowInstanceId,
            executionId: delegated.executionId,
          },
          provenance,
        }),
      );
      appendedDecisions.push(delegationDecision);

      return {
        controller,
        reconciledSteps,
        dispatchedStep: delegated,
        terminated: false,
        decisions: appendedDecisions,
        events: appendedEvents,
      };
    },

    async pauseController(input, provenance) {
      assertValidGrowthOperatorProvenance(provenance);
      assertValidGrowthOperatorReason(input.reason);
      const controller = await requireController(input.missionId);
      if (isTerminal(controller.status)) {
        throw new ConflictError(`controller of mission ${input.missionId} is ${controller.status} (terminal) and frozen`);
      }
      const outcome = await transitionController(store, deps, controller, {
        to: 'paused',
        reason: input.reason,
        blockedGateKind: null,
        terminalCause: null,
      }, provenance);
      // The mission record mirrors the deliberate pause (through the
      // mission authority's own command).
      const mission = await missions.getGrowthMission(input.missionId);
      if (mission !== null && mission.status === MISSION_ACTIVE) {
        await missions.setGrowthMissionStatus(
          {
            missionId: input.missionId,
            status: MISSION_PAUSED,
            reason: `growth operator controller paused: ${input.reason}`,
            expectedVersion: mission.version,
          },
          provenance,
        );
      }
      return detailFrom(outcome.controller, store, missions);
    },

    async resumeController(input, provenance) {
      assertValidGrowthOperatorProvenance(provenance);
      assertValidGrowthOperatorReason(input.reason);
      const controller = await requireController(input.missionId);
      if (isTerminal(controller.status)) {
        throw new ConflictError(`controller of mission ${input.missionId} is ${controller.status} (terminal) and frozen`);
      }
      if (controller.status === 'running') {
        throw new ConflictError(`controller of mission ${input.missionId} is already running`);
      }
      const outcome = await transitionController(store, deps, controller, {
        to: 'running',
        reason: input.reason,
        blockedGateKind: null,
        terminalCause: null,
      }, provenance);
      // The mission record mirrors the resume (only when it is paused).
      const mission = await missions.getGrowthMission(input.missionId);
      if (mission !== null && mission.status === MISSION_PAUSED) {
        await missions.setGrowthMissionStatus(
          {
            missionId: input.missionId,
            status: MISSION_ACTIVE,
            reason: `growth operator controller resumed: ${input.reason}`,
            expectedVersion: mission.version,
          },
          provenance,
        );
      }
      return detailFrom(outcome.controller, store, missions);
    },

    async terminateControllerByPolicy(input, provenance) {
      assertValidGrowthOperatorProvenance(provenance);
      assertValidGrowthOperatorReason(input.reason);
      const controller = await requireController(input.missionId);
      if (isTerminal(controller.status)) {
        throw new ConflictError(`controller of mission ${input.missionId} is ${controller.status} (terminal) and frozen`);
      }
      const mission = await missions.getGrowthMission(input.missionId);
      const outcome = await terminateController(store, deps, controller, {
        terminalCause: input.terminalCause,
        missionTerminalStatus: input.missionTerminalStatus,
        reason: input.reason,
        mission: mission ?? undefined,
      }, provenance);
      return detailFrom(outcome.controller, store, missions);
    },

    async getController(missionId) {
      return store.getController(missionId);
    },

    async getControllerDetail(missionId) {
      const controller = await store.getController(missionId);
      if (controller === null) return null;
      return detailFrom(controller, store, missions);
    },

    async listControllerDecisions(missionId) {
      const controller = await store.getController(missionId);
      if (controller === null) return null;
      return store.listDecisions(missionId);
    },

    async listControllerEvents(missionId) {
      const controller = await store.getController(missionId);
      if (controller === null) return null;
      return store.listEvents(controller.controllerId);
    },

    async listControllerPlanSteps(missionId) {
      const controller = await store.getController(missionId);
      if (controller === null) return null;
      return store.listPlanSteps(missionId);
    },
  };

  // -------------------------------------------------------------------------
  // Internal helpers (closures over the module deps)
  // -------------------------------------------------------------------------

  async function requireController(missionId: string): Promise<GrowthOperatorControllerRecord> {
    const controller = await store.getController(missionId);
    if (controller === null) {
      throw new NotFoundError('growth operator controller', missionId);
    }
    return controller;
  }

  async function detailOrThrow(missionId: string): Promise<GrowthOperatorControllerDetail> {
    const detail = await detailFrom(await requireController(missionId), store, missions);
    return detail;
  }
}

function isTerminal(status: GrowthOperatorControllerStatus): boolean {
  return status === 'achieved' || status === 'exhausted' || status === 'terminated_by_policy';
}

/** The strategy version reference for decision rationales. */
const GROWTH_OPERATOR_STRATEGY_VERSION_REF: string = GROWTH_OPERATOR_STRATEGY_VERSION;

async function detailFrom(
  controller: GrowthOperatorControllerRecord,
  store: GrowthOperatorStore,
  missions: GrowthOperatorModuleDeps['missions'],
): Promise<GrowthOperatorControllerDetail> {
  const [mission, planSteps, decisions, events] = await Promise.all([
    missions.getGrowthMission(controller.missionId),
    store.listPlanSteps(controller.missionId),
    store.listDecisions(controller.missionId),
    store.listEvents(controller.controllerId),
  ]);
  return {
    controller,
    mission: {
      missionId: controller.missionId,
      status: mission?.status ?? 'unknown',
      currentVersionSeq: mission?.currentVersionSeq ?? 0,
    },
    planSteps,
    decisions,
    events,
  };
}

// ---------------------------------------------------------------------------
// The state transition helper (locked CAS + event + decision)
// ---------------------------------------------------------------------------

interface TransitionOutcome {
  readonly controller: GrowthOperatorControllerRecord;
  readonly decisions: readonly GrowthOperatorDecisionRecord[];
  readonly events: readonly GrowthOperatorEventRecord[];
}

async function transitionController(
  store: GrowthOperatorStore,
  deps: GrowthOperatorModuleDeps,
  controller: GrowthOperatorControllerRecord,
  input: {
    readonly to: GrowthOperatorControllerStatus;
    readonly reason: string;
    readonly blockedGateKind: 'rights' | 'policy' | 'capability' | null;
    readonly terminalCause: GrowthOperatorTerminalCause | null;
  },
  provenance: GrowthOperatorProvenance,
  decision?: {
    readonly decisionKind: GrowthOperatorDecisionKind;
    readonly treatmentFamily: GrowthOperatorTreatmentFamily | null;
    readonly rationale: string;
    readonly detail: Readonly<Record<string, unknown>>;
  },
): Promise<TransitionOutcome> {
  return await deps.db.transaction(async (tx) => {
    const current = await store.lockController(tx, controller.missionId);
    if (current === null) {
      throw new NotFoundError('growth operator controller', controller.missionId);
    }
    if (current.status !== controller.status || current.version !== controller.version) {
      throw new ConflictError(
        `controller of mission ${controller.missionId} moved (current ${current.status} v${current.version}; expected ${controller.status} v${controller.version}) — re-run the operation`,
      );
    }
    const result = await store.updateControllerStatusRow(tx, {
      controllerId: controller.controllerId,
      status: input.to,
      blockedReason: input.to === 'blocked_pending_human_action' ? input.reason : null,
      blockedGateKind: input.blockedGateKind,
      expectedVersion: controller.version,
    });
    if (result !== 'ok') {
      throw new ConflictError(`controller of mission ${controller.missionId} state update lost the version race`);
    }
    const event = await store.appendEvent(tx, {
      controllerId: controller.controllerId,
      missionId: controller.missionId,
      fromStatus: controller.status,
      toStatus: input.to,
      terminalCause: input.terminalCause,
      blockedGateKind: input.blockedGateKind,
      reason: input.reason,
      provenance,
    });
    const decisions: GrowthOperatorDecisionRecord[] = [];
    if (decision !== undefined) {
      decisions.push(
        await store.appendDecision(tx, {
          controllerId: controller.controllerId,
          missionId: controller.missionId,
          decisionKind: decision.decisionKind,
          treatmentFamily: decision.treatmentFamily,
          rationale: decision.rationale,
          evidenceRefs: [],
          detail: decision.detail,
          provenance,
        }),
      );
    }
    // The honest post-transition read-back (the record AFTER the CAS).
    const updated = await store.getControllerById(tx, controller.controllerId);
    if (updated === null) {
      throw new NotFoundError('growth operator controller', controller.controllerId);
    }
    return {
      controller: updated,
      decisions,
      events: [event],
    };
  });
}

// ---------------------------------------------------------------------------
// The termination helper (the honest end)
// ---------------------------------------------------------------------------

async function terminateController(
  store: GrowthOperatorStore,
  deps: GrowthOperatorModuleDeps,
  controller: GrowthOperatorControllerRecord,
  input: {
    readonly terminalCause: GrowthOperatorTerminalCause;
    /** null when the mission is ALREADY terminal (nothing to record there). */
    readonly missionTerminalStatus: GrowthMissionStatus | null;
    readonly reason: string;
    /** The live mission row (for the CAS transition). */
    readonly mission?:
      | {
          readonly missionId: string;
          readonly status: GrowthMissionStatus;
          readonly version: number;
        }
      | null
      | undefined;
  },
  provenance: GrowthOperatorProvenance,
): Promise<TransitionOutcome> {
  // The honest mission recording FIRST (through the mission authority's own
  // command): from 'active' every terminal status is legal; from 'paused'
  // only stopped_by_user is (the frozen mission machine) — the reason
  // carries the honest cause either way.
  if (input.missionTerminalStatus !== null && input.mission !== null && input.mission !== undefined) {
    const missionStatus = input.mission.status;
    if (!MISSION_TERMINAL_STATUSES.has(missionStatus)) {
      const target =
        missionStatus === MISSION_PAUSED
          ? 'stopped_by_user' // the only legal terminal from paused (the frozen mission machine)
          : input.missionTerminalStatus;
      await deps.missions.setGrowthMissionStatus(
        {
          missionId: input.mission.missionId,
          status: target,
          reason: `growth operator terminated pursuit (${input.terminalCause}): ${input.reason}`,
          expectedVersion: input.mission.version,
        },
        provenance,
      );
    }
  }
  return await transitionController(
    store,
    deps,
    controller,
    {
      to: 'terminated_by_policy',
      reason: `${input.reason} (terminal cause: ${input.terminalCause})`,
      blockedGateKind: null,
      terminalCause: input.terminalCause,
    },
    provenance,
    {
      decisionKind: 'termination',
      treatmentFamily: null,
      rationale: `Pursuit terminated by policy — cause '${input.terminalCause}': ${input.reason}`,
      detail: {
        terminalCause: input.terminalCause,
        missionTerminalStatus: input.missionTerminalStatus,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// THE DELEGATION SEQUENCE (convergent — all through the EXISTING authorities)
// ---------------------------------------------------------------------------

async function driveDelegation(
  store: GrowthOperatorStore,
  deps: GrowthOperatorModuleDeps,
  controller: GrowthOperatorControllerRecord,
  step: GrowthOperatorPlanStepRecord,
  provenance: GrowthOperatorProvenance,
): Promise<GrowthOperatorPlanStepRecord> {
  const { workflows, executions, experiments, decisions } = deps;
  let current = step;

  // 1. THE EXPERIMENT (through /experiments — the bounded next experiment
  //    identity; the hypothesis embeds the step tag so a crash-window
  //    re-drive converges to the SAME experiment).
  if (current.experimentId === null) {
    const stepTag = `go-step:${current.stepId}`;
    let experimentId: string | null = null;
    const existing = await experiments.listExperimentsForClient(controller.pursuitClientId);
    const found = existing.find((experiment) => experiment.hypothesis.includes(stepTag));
    if (found !== undefined) {
      experimentId = found.experimentId;
    } else {
      const created = await experiments.createExperiment(
        {
          clientId: controller.pursuitClientId,
          workspaceId: controller.pursuitWorkspaceId,
          hypothesis: `Growth operator plan step ${current.stepSeq} (mission ${controller.missionId}, ${stepTag}): bounded ${current.treatmentFamily} treatment of the declared objective`,
          decisionTarget: `mission ${controller.missionId} pursuit decision`,
          populationUnit: 'mission audience exposure',
          treatment: current.treatmentFamily,
          comparison: 'mission baseline (no new treatment)',
          assignmentMethod: 'operator-selected bounded next action',
          designType: 'quasi_experimental',
          primaryMetric: {
            name: 'mission_primary_outcome',
            dimensions: { mission_id: controller.missionId, step_seq: current.stepSeq },
          },
          guardrails: [
            { name: 'delegation_cost', dimensions: { unit: 'workflow_execution' } },
          ],
          analysisMethod: 'operator observation of delegated workflow outcome',
          analysisMethodVersion: null,
          expectedDirection: 'increase',
          startCriteria: null,
          stopCriteria: 'the delegated workflow instance reaches a terminal state',
          minimumEvidenceRequirement: 'the delegated work outcome observation recorded through /evidence',
          uncertaintyRepresentation: 'none',
        },
        provenance,
      );
      experimentId = created.experimentId;
    }
    await deps.db.transaction(async (tx) => {
      await store.fillPlanStepDelegationRefs(tx, { stepId: current.stepId, experimentId: experimentId! });
    });
    current = { ...current, experimentId: experimentId! };
  }

  // 2. THE DECISION LEDGER RECORD (through /decisions — the §8 fence makes
  //    this the durable convergence anchor: the key is step-derived).
  if (current.decisionId === null) {
    const created = await decisions.createDecision(
      {
        clientId: controller.pursuitClientId,
        workspaceId: controller.pursuitWorkspaceId,
        objective: `Growth operator plan step ${current.stepSeq} of mission ${controller.missionId}`,
        context: `strategy ${controller.strategyVersion}; evidence snapshot ${current.evidenceSnapshotDigest}`,
        hypothesisSummary: current.rationale,
        experimentRef: current.experimentId,
        evidenceRefs: [],
        expectedImpact: {
          summary: `the bounded ${current.treatmentFamily} treatment is expected to advance the mission's declared objective`,
          direction: 'increase',
          magnitude: null,
        },
        uncertainty: null,
        expectedCost: 'one delegated workflow execution',
        alternatives: ['no action this cycle'],
        predecessorDecisionId: null,
        idempotencyKey: `go-decision-${current.stepId}`,
      },
      { actor: provenance.actor, role: 'service' },
      provenance,
    );
    await deps.db.transaction(async (tx) => {
      await store.fillPlanStepDelegationRefs(tx, { stepId: current.stepId, decisionId: created.decision.decisionId });
    });
    current = { ...current, decisionId: created.decision.decisionId };
  }

  // 3. THE PURSUIT WORKFLOW CONTAINER (find-or-create by the deterministic
  //    mission-derived name — convergent).
  let workflowId: string | null = controller.pursuitWorkflowId;
  if (current.workflowId !== null) {
    workflowId = current.workflowId;
  }
  if (workflowId === null) {
    const workflowName = `growth-operator-pursuit-${controller.missionId}`;
    const existing = await workflows.listWorkflowsForWorkspace(controller.pursuitWorkspaceId);
    const found = existing.find((workflow) => workflow.name === workflowName);
    if (found !== undefined) {
      workflowId = found.workflowId;
    } else {
      const created = await workflows.createWorkflow({
        workspaceId: controller.pursuitWorkspaceId,
        name: workflowName,
        description: `The growth operator pursuit container of mission ${controller.missionId} (MKT-054)`,
        actorId: null,
      });
      workflowId = created.workflowId;
    }
  }
  {
    const resolvedWorkflowId: string = workflowId;
    await deps.db.transaction(async (tx) => {
      await store.fillPursuitWorkflow(tx, { controllerId: controller.controllerId, workflowId: resolvedWorkflowId });
      await store.fillPlanStepDelegationRefs(tx, { stepId: current.stepId, workflowId: resolvedWorkflowId });
    });
    current = { ...current, workflowId: resolvedWorkflowId };
  }

  // 4. THE STEP DEFINITION (find-or-create by the step-derived node id).
  const runNodeId = `go_s${current.stepSeq}_run_treatment`;
  const outcomeNodeId = `go_s${current.stepSeq}_record_outcome`;
  let definitionId = current.workflowDefinitionId;
  if (definitionId === null) {
    const existing = await workflows.listWorkflowDefinitions(workflowId);
    const found = existing.find((definition) => {
      const content = definition.content as {
        readonly graph?: { readonly nodes?: readonly { readonly nodeId: string }[] };
      } | null;
      return content?.graph?.nodes?.some((node) => node.nodeId === runNodeId) ?? false;
    });
    if (found !== undefined) {
      definitionId = found.workflowDefinitionId;
    } else {
      const created = await workflows.createWorkflowDefinition({
        workflowId,
        content: buildStepDefinitionContent(runNodeId, outcomeNodeId, current.treatmentFamily),
        playbookVersionId: null,
        actorId: null,
      });
      definitionId = created.workflowDefinitionId;
    }
    await deps.db.transaction(async (tx) => {
      await store.fillPlanStepDelegationRefs(tx, { stepId: current.stepId, workflowDefinitionId: definitionId });
    });
    current = { ...current, workflowDefinitionId: definitionId };
  }

    // Activate the definition through the authority's own lifecycle (draft →
    // review → active; each transition CAS-guarded).
  let definition = await workflows.getWorkflowDefinition(current.workflowDefinitionId!);
  if (definition === null) {
    throw new NotFoundError('workflow definition', current.workflowDefinitionId!);
  }
  if (definition.status === 'draft') {
    definition = await workflows.setWorkflowDefinitionStatus({
      definitionId: current.workflowDefinitionId!,
      status: 'review',
      expectedVersion: definition.version,
    });
  }
  if (definition.status === 'review') {
    definition = await workflows.setWorkflowDefinitionStatus({
      definitionId: current.workflowDefinitionId!,
      status: 'active',
      expectedVersion: definition.version,
    });
  }

  // 5. THE STEP INSTANCE (find-or-create by the pinned definition).
  let instanceId = current.workflowInstanceId;
  if (instanceId === null) {
    const existing = await workflows.listWorkflowInstances(workflowId);
    const found = existing.find((instance) => instance.workflowDefinitionId === definitionId);
    if (found !== undefined) {
      instanceId = found.workflowInstanceId;
    } else {
      const created = await workflows.createWorkflowInstance({
        workflowId,
        workflowDefinitionId: definitionId!,
        actorId: null,
      });
      instanceId = created.workflowInstanceId;
    }
    await deps.db.transaction(async (tx) => {
      await store.fillPlanStepDelegationRefs(tx, { stepId: current.stepId, workflowInstanceId: instanceId });
    });
    current = { ...current, workflowInstanceId: instanceId };
  }

  // 6. THE INSTANCE LIFECYCLE through the authority's own transition
  //    command (idempotency-keyed — convergent on re-drive). The operator
  //    REQUESTS the work; it never executes it.
  let instance = await workflows.getWorkflowInstance(instanceId!);
  if (instance === null) {
    throw new NotFoundError('workflow instance', instanceId!);
  }
  if (instance.status === 'draft') {
    const outcome = await workflows.transitionWorkflowInstance({
      instanceId: instanceId!,
      to: 'ready',
      expectedVersion: instance.version,
      idempotencyKey: `go-${current.stepId}-ready`,
      reason: 'growth operator delegation: stage the bounded treatment step',
      actorId: null,
    });
    instance = outcome.instance;
  }
  if (instance.status === 'ready') {
    const outcome = await workflows.transitionWorkflowInstance({
      instanceId: instanceId!,
      to: 'running',
      expectedVersion: instance.version,
      idempotencyKey: `go-${current.stepId}-running`,
      reason: 'growth operator delegation: request the bounded treatment work',
      actorId: null,
    });
    instance = outcome.instance;
  }

  // 7. THE EXECUTION (through /executions — born 'created'; the §8 fence is
  //    the hard no-double-dispatch guarantee; the runtime plane owns the
  //    lifecycle from here).
  let executionId = current.executionId;
  if (executionId === null) {
    const created = await executions.createExecution({
      workspaceId: controller.pursuitWorkspaceId,
      taskLink: {
        kind: 'workflow-node',
        workflowInstanceId: instanceId!,
        nodeId: runNodeId,
      },
      retryOfExecutionId: null,
      executionKind: 'deterministic',
      runtimeClass: 'pooled-worker',
      idempotencyKey: `go-exec-${current.stepId}`,
      actorId: null,
    });
    executionId = created.execution.executionId;
    await deps.db.transaction(async (tx) => {
      await store.fillPlanStepDelegationRefs(tx, { stepId: current.stepId, executionId });
    });
    current = { ...current, executionId };
  }

  // 8. THE DISPATCH MARK (the plan step completes its planned → dispatched
  //    transition; the full delegation identity is recorded).
  await deps.db.transaction(async (tx) => {
    const fresh = await store.findPlanStepByIdempotencyKey(tx, current.missionId, current.idempotencyKey);
    if (fresh === null) {
      throw new NotFoundError('growth operator plan step', current.stepId);
    }
    if (fresh.state === 'planned') {
      const result = await store.markPlanStepDispatched(tx, {
        stepId: current.stepId,
        expectedVersion: fresh.version,
      });
      if (result !== 'ok') {
        throw new ConflictError(`plan step ${current.stepId} dispatch mark lost the version race`);
      }
    }
  });

  return { ...current, state: 'dispatched' };
}

/**
 * The delegated step's workflow definition content — a minimal, valid §4
 * typed graph: one deterministic entry staging the treatment, one
 * `experiment` node carrying the bounded treatment (the executable work
 * the runtime plane picks up through the execution authority), one
 * `terminal` outcome recorder. Deterministic node ids derived from the
 * step sequence (the definition find-or-create anchor).
 */
function buildStepDefinitionContent(
  runNodeId: string,
  outcomeNodeId: string,
  treatmentFamily: GrowthOperatorTreatmentFamily,
): WorkflowDefinitionContent {
  const emptyObjectSchema = { type: 'object' as const, properties: {}, required: [] };
  return {
    graph: {
      nodes: [
        {
          nodeId: 'go_entry_stage_treatment',
          nodeType: 'function',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              treatment_staged: {
                type: 'boolean',
                description: `the ${treatmentFamily} treatment inputs were staged for the delegated work`,
              },
            },
            required: [],
          },
          executionPolicyRef: null,
          retryPolicy: null,
          timeout: null,
          idempotencyKeyStrategy: 'workflow',
          humanApproval: null,
          join: null,
          loop: null,
        },
        {
          nodeId: runNodeId,
          nodeType: 'experiment',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              treatment_outcome: {
                type: 'string',
                description: 'the delegated treatment outcome observed by the runtime plane',
              },
            },
            required: [],
          },
          executionPolicyRef: null,
          retryPolicy: { maxAttempts: 2, backoffMs: null },
          timeout: { seconds: 300 },
          idempotencyKeyStrategy: 'workflow',
          humanApproval: null,
          join: null,
          loop: null,
        },
        {
          nodeId: outcomeNodeId,
          nodeType: 'terminal',
          inputMapping: {},
          outputSchema: emptyObjectSchema,
          executionPolicyRef: null,
          retryPolicy: null,
          timeout: null,
          idempotencyKeyStrategy: null,
          humanApproval: null,
          join: null,
          loop: null,
        },
      ],
      edges: [
        {
          fromNode: 'go_entry_stage_treatment',
          toNode: runNodeId,
          edgeType: 'success',
          predicateRef: null,
          joinSemantics: null,
        },
        {
          fromNode: runNodeId,
          toNode: outcomeNodeId,
          edgeType: 'success',
          predicateRef: null,
          joinSemantics: null,
        },
      ],
    },
    inputSchema: emptyObjectSchema,
    outputSchema: emptyObjectSchema,
    retryPolicyDefaults: { maxAttempts: null, backoffMs: null },
    concurrencyLimits: { maxConcurrentWorkflows: null, maxConcurrentNodes: null },
    timeoutPolicy: { defaultTimeoutSeconds: null, maxTimeoutSeconds: null },
    compensation: [],
  };
}

// ---------------------------------------------------------------------------
// The default delegation gate: the REAL /policies engine (fail closed)
// ---------------------------------------------------------------------------

function policiesComposedGate(
  policies: GrowthOperatorModuleDeps['policies'],
): GrowthOperatorDelegationGatePort {
  return {
    async evaluateDelegation(input, provenance) {
      const decision = await policies.evaluateAction(
        {
          action: {
            dimension: 'tools',
            operation: 'growth-operator.delegate',
            resource: input.missionId,
            attributes: {
              treatment_family: input.treatmentFamily,
              mission_id: input.missionId,
            },
          },
          scope: { agencyId: input.agencyId, clientId: input.clientId },
        },
        provenance,
      );
      if (decision.outcome === 'allow') {
        return {
          outcome: 'allow' as const,
          gateKind: null,
          reason: `policy decision ${decision.decisionId} allowed the delegation (${decision.reasonCode})`,
          policyDecisionRef: decision.decisionId,
        };
      }
      if (decision.outcome === 'deny') {
        // An explicit DENY is a genuine human-declared governance boundary:
        // the honest controller state is blocked_pending_human_action (a
        // human must change the policy or the mission) — never a silent
        // skip and never a fabricated continuation.
        return {
          outcome: 'deny_pending_human_action' as const,
          gateKind: 'policy' as const,
          reason: `policy decision ${decision.decisionId} denied the delegation (${decision.reasonCode}: ${decision.reasons.join('; ')})`,
          policyDecisionRef: decision.decisionId,
        };
      }
      // UNDECIDED fails closed: the treatment is skipped, only an explicit
      // allow permits.
      return {
        outcome: 'deny' as const,
        gateKind: null,
        reason: `policy evaluation was undecided (${decision.reasonCode}) — failing closed`,
        policyDecisionRef: decision.decisionId,
      };
    },
  };
}
