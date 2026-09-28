/**
 * /lab module implementation (LAB-001 — the Marketing Engineering Lab
 * Contracts and Run Model).
 *
 * THE ORCHESTRATION ONLY: this module composes the LabStore (the
 * migration-059 tables) with the PURE contract guards of validation.ts —
 * every create/transition passes the frozen contract semantics BEFORE
 * touching the store, and the store's guarded UPDATEs + the migration
 * triggers backstop every lifecycle rule (defense in depth; the DB
 * fences are the authority, the module guards are the honest error
 * surface).
 *
 * THE RUN MODEL (§23): runs are created QUEUED against an ACTIVE
 * scenario (the newest version; the run pins the scenario version it
 * bound), start under the per-client active-run concurrency cap, pause/
 * resume with the SAME recorded seeds and configuration (§9
 * reproducibility survives the pause/resume pair), complete with the
 * output artifact lineage, and fail/cancel with the closed failure
 * vocabulary. Every transition rides the append-only event tail.
 *
 * THE SCOPE DISCIPLINE (§22): every read resolves foreign/unknown scope
 * to the uniform NotFound (no existence oracle) — exactly the
 * platform-health/content-intelligence house pattern.
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import { isUuid } from '../../../platform/ids/ids.ts';
import type {
  LabModuleApi,
  LabModuleDeps,
  LabScenarioRecord,
  LabScope,
} from '../public.ts';
import { LAB_MAX_ACTIVE_RUNS_PER_CLIENT, LAB_MAX_SCENARIO_VERSIONS } from '../public.ts';
import {
  assertValidLabFactualityForMode,
  assertValidLabRewardDefinition,
  assertValidLabRunConfiguration,
  assertValidLabRunTimeMachine,
  assertValidLabSeedSet,
  defaultLabFactualityForMode,
} from './validation.ts';
import {
  LabStore,
  mapRunRow,
  mapScenarioRow,
  mapStrategyCandidateRow,
  mapOrganizationCandidateRow,
  mapCapabilityCandidateRow,
  mapCalibrationRecordRow,
} from './lab-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(resource: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError(resource, id);
  }
}

function assertScope(scope: LabScope): void {
  if (!scope || !UUID_PATTERN.test(String(scope.agencyId)) || !UUID_PATTERN.test(String(scope.clientId))) {
    throw new InvalidRequestError('scope.agencyId and scope.clientId must be UUIDs');
  }
  if (scope.workspaceId != null && !UUID_PATTERN.test(String(scope.workspaceId))) {
    throw new InvalidRequestError('scope.workspaceId must be a UUID when present');
  }
}

export function createLabModule(deps: LabModuleDeps): LabModuleApi {
  const store = new LabStore(deps.db, deps.clock, deps.ids);

  // -----------------------------------------------------------------------
  // Scenario lifecycle
  // -----------------------------------------------------------------------

  async function requireLatestScenario(scope: LabScope, scenarioId: string): Promise<LabScenarioRecord> {
    assertUuidShape('lab scenario', scenarioId);
    const row = await store.findLatestScenario(scope.clientId, scenarioId);
    if (!row) throw new NotFoundError('lab scenario', scenarioId);
    return mapScenarioRow(row);
  }

  return {
    async createScenario(input) {
      assertScope(input.scope);
      assertValidLabRewardDefinition(input.reward);
      assertValidLabRunConfiguration(input.runConfiguration);
      if (input.binding === null || typeof input.binding !== 'object') {
        throw new InvalidRequestError('binding must be an object');
      }
      const scenarioId = deps.ids.newId();
      await store.insertScenario({
        scenarioId,
        scenarioVersion: 1,
        scope: input.scope,
        status: 'draft',
        binding: input.binding,
        rewardDefinition: input.reward,
        runConfiguration: input.runConfiguration,
      });
      const row = await store.findLatestScenario(input.scope.clientId, scenarioId);
      if (!row) throw new NotFoundError('lab scenario', scenarioId);
      return mapScenarioRow(row);
    },

    async getScenario(scope, scenarioId) {
      assertScope(scope);
      return requireLatestScenario(scope, scenarioId);
    },

    async listScenarios(scope) {
      assertScope(scope);
      const rows = await store.listScenarios(scope.clientId);
      // One entry per scenario (the newest version — the resolvable one).
      const newest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        newest.set(row.scenario_id, row);
      }
      return [...newest.values()].map(mapScenarioRow);
    },

    async activateScenario(scope, scenarioId) {
      assertScope(scope);
      const scenario = await requireLatestScenario(scope, scenarioId);
      if (scenario.status !== 'draft') {
        throw new InvalidRequestError(`lab scenario ${scenarioId} is ${scenario.status} — only a draft scenario can be activated`);
      }
      const row = await store.updateScenarioStatus(scope.clientId, scenarioId, scenario.scenarioVersion, 'active');
      if (!row) throw new NotFoundError('lab scenario', scenarioId);
      return mapScenarioRow(row);
    },

    async retireScenario(scope, scenarioId) {
      assertScope(scope);
      const scenario = await requireLatestScenario(scope, scenarioId);
      if (scenario.status !== 'active') {
        throw new InvalidRequestError(`lab scenario ${scenarioId} is ${scenario.status} — only an active scenario can be retired`);
      }
      const row = await store.updateScenarioStatus(scope.clientId, scenarioId, scenario.scenarioVersion, 'retired');
      if (!row) throw new NotFoundError('lab scenario', scenarioId);
      return mapScenarioRow(row);
    },

    async correctScenario(scope, scenarioId, correction) {
      assertScope(scope);
      const scenario = await requireLatestScenario(scope, scenarioId);
      if (scenario.scenarioVersion >= LAB_MAX_SCENARIO_VERSIONS) {
        throw new InvalidRequestError(`lab scenario ${scenarioId} has reached the version chain bound (${LAB_MAX_SCENARIO_VERSIONS})`);
      }
      const binding = correction.binding ?? scenario.binding;
      const reward = correction.reward ?? scenario.reward;
      const runConfiguration = correction.runConfiguration ?? scenario.runConfiguration;
      assertValidLabRewardDefinition(reward);
      assertValidLabRunConfiguration(runConfiguration);
      // A correction starts a fresh chain as draft (the frozen-at-run
      // gate applies per version: the corrected version must be
      // re-activated before new runs bind it).
      await store.insertScenario({
        scenarioId,
        scenarioVersion: scenario.scenarioVersion + 1,
        scope: {
          agencyId: scenario.agencyId,
          clientId: scenario.clientId,
          workspaceId: scenario.workspaceId,
        },
        status: 'draft',
        binding,
        rewardDefinition: reward,
        runConfiguration,
      });
      const row = await store.findScenarioVersion(scope.clientId, scenarioId, scenario.scenarioVersion + 1);
      if (!row) throw new NotFoundError('lab scenario', scenarioId);
      return mapScenarioRow(row);
    },

    // -----------------------------------------------------------------------
    // Run model
    // -----------------------------------------------------------------------

    async createRun(input) {
      assertScope(input.scope);
      assertValidLabRunTimeMachine(input.timeMachine);
      assertValidLabSeedSet(input.seeds);
      const scenario = await requireLatestScenario(input.scope, input.scenarioId);
      if (scenario.status !== 'active') {
        throw new InvalidRequestError(`lab scenario ${input.scenarioId} is ${scenario.status} — runs bind only ACTIVE scenarios`);
      }
      assertValidLabRunConfiguration(scenario.runConfiguration);
      // The factuality label: explicit via the mode default; the §3/§10
      // mode-consistency guard applies (a counterfactual run can never
      // carry the factual_historical_replay label).
      const factuality = defaultLabFactualityForMode(input.timeMachine.mode);
      assertValidLabFactualityForMode(factuality, input.timeMachine.mode);
      const active = await store.countActiveRuns(input.scope.clientId);
      if (active >= LAB_MAX_ACTIVE_RUNS_PER_CLIENT) {
        throw new InvalidRequestError(
          `client ${input.scope.clientId} already has ${active} active lab runs — the concurrency cap is ${LAB_MAX_ACTIVE_RUNS_PER_CLIENT} (§23)`,
        );
      }
      const runId = deps.ids.newId();
      await store.insertRun({
        runId,
        scenarioId: input.scenarioId,
        scenarioVersion: scenario.scenarioVersion,
        scope: input.scope,
        timeMachine: input.timeMachine,
        seeds: input.seeds,
        configuration: scenario.runConfiguration,
        configurationOverrides: input.configurationOverrides ?? null,
        factuality,
      });
      const row = await store.findRun(input.scope.clientId, runId);
      if (!row) throw new NotFoundError('lab run', runId);
      return mapRunRow(row);
    },

    async getRun(scope, runId) {
      assertScope(scope);
      assertUuidShape('lab run', runId);
      const row = await store.findRun(scope.clientId, runId);
      if (!row) throw new NotFoundError('lab run', runId);
      return mapRunRow(row);
    },

    async listRuns(scope, scenarioId) {
      assertScope(scope);
      if (scenarioId !== undefined) assertUuidShape('lab scenario', scenarioId);
      const rows = await store.listRuns(scope.clientId, scenarioId);
      return rows.map(mapRunRow);
    },

    async startRun(scope, runId) {
      assertScope(scope);
      assertUuidShape('lab run', runId);
      const run = await this.getRun(scope, runId);
      if (run.status !== 'queued') {
        throw new InvalidRequestError(`lab run ${runId} is ${run.status} — only a queued run can start`);
      }
      const active = await store.countActiveRuns(scope.clientId);
      if (active > LAB_MAX_ACTIVE_RUNS_PER_CLIENT) {
        throw new InvalidRequestError(`client ${scope.clientId} exceeds the active-run concurrency cap (${LAB_MAX_ACTIVE_RUNS_PER_CLIENT}, §23)`);
      }
      const row = await store.transitionRun(scope.clientId, runId, 'queued', 'running', 'run started', null, null);
      if (!row) throw new NotFoundError('lab run', runId);
      return mapRunRow(row);
    },

    async pauseRun(scope, runId) {
      assertScope(scope);
      assertUuidShape('lab run', runId);
      const run = await this.getRun(scope, runId);
      if (run.status !== 'running') {
        throw new InvalidRequestError(`lab run ${runId} is ${run.status} — only a running run can pause`);
      }
      const row = await store.transitionRun(scope.clientId, runId, 'running', 'paused', 'run paused (resumable)', null, null);
      if (!row) throw new NotFoundError('lab run', runId);
      return mapRunRow(row);
    },

    async resumeRun(scope, runId) {
      assertScope(scope);
      assertUuidShape('lab run', runId);
      const run = await this.getRun(scope, runId);
      if (run.status !== 'paused') {
        throw new InvalidRequestError(`lab run ${runId} is ${run.status} — only a paused run can resume`);
      }
      const row = await store.transitionRun(scope.clientId, runId, 'paused', 'running', 'run resumed (same seeds and configuration)', null, null);
      if (!row) throw new NotFoundError('lab run', runId);
      return mapRunRow(row);
    },

    async completeRun(scope, runId, outputArtifacts) {
      assertScope(scope);
      assertUuidShape('lab run', runId);
      const run = await this.getRun(scope, runId);
      if (run.status !== 'running') {
        throw new InvalidRequestError(`lab run ${runId} is ${run.status} — only a running run can complete`);
      }
      if (!Array.isArray(outputArtifacts) || outputArtifacts.length > 128) {
        throw new InvalidRequestError('outputArtifacts must be an array of at most 128 entries');
      }
      for (const artifact of outputArtifacts) {
        if (!artifact || typeof artifact.kind !== 'string' || artifact.kind.length < 1 || artifact.kind.length > 64
            || typeof artifact.version !== 'string' || artifact.version.length < 1 || artifact.version.length > 128) {
          throw new InvalidRequestError('each output artifact must carry kind (1-64 chars) and version (1-128 chars)');
        }
      }
      const row = await store.transitionRun(scope.clientId, runId, 'running', 'succeeded', 'run completed', null, outputArtifacts);
      if (!row) throw new NotFoundError('lab run', runId);
      return mapRunRow(row);
    },

    async failRun(scope, runId, reason) {
      assertScope(scope);
      assertUuidShape('lab run', runId);
      const run = await this.getRun(scope, runId);
      if (run.status !== 'running' && run.status !== 'paused' && run.status !== 'queued') {
        throw new InvalidRequestError(`lab run ${runId} is ${run.status} — only a non-terminal run can fail`);
      }
      const row = await store.transitionRun(scope.clientId, runId, run.status, 'failed', `run failed: ${reason}`, reason, null);
      if (!row) throw new NotFoundError('lab run', runId);
      return mapRunRow(row);
    },

    async cancelRun(scope, runId) {
      assertScope(scope);
      assertUuidShape('lab run', runId);
      const run = await this.getRun(scope, runId);
      if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'paused') {
        throw new InvalidRequestError(`lab run ${runId} is ${run.status} — only a non-terminal run can be cancelled`);
      }
      const row = await store.transitionRun(scope.clientId, runId, run.status, 'cancelled', 'run cancelled by operator', null, null);
      if (!row) throw new NotFoundError('lab run', runId);
      return mapRunRow(row);
    },

    // -----------------------------------------------------------------------
    // Candidates
    // -----------------------------------------------------------------------

    async createStrategyCandidate(input) {
      assertScope(input.scope);
      const scenario = await requireLatestScenario(input.scope, input.scenarioId);
      if (input.declaration === null || typeof input.declaration !== 'object') {
        throw new InvalidRequestError('declaration must be an object');
      }
      const candidateId = deps.ids.newId();
      await store.insertStrategyCandidate({
        candidateId,
        scenarioId: input.scenarioId,
        scenarioVersion: scenario.scenarioVersion,
        scope: input.scope,
        declaration: input.declaration,
      });
      const row = await store.findStrategyCandidate(input.scope.clientId, candidateId);
      if (!row) throw new NotFoundError('lab strategy candidate', candidateId);
      const evaluations = await store.listStrategyCandidateEvaluations([candidateId]);
      return mapStrategyCandidateRow(row, evaluations.get(candidateId) ?? []);
    },

    async getStrategyCandidate(scope, candidateId) {
      assertScope(scope);
      assertUuidShape('lab strategy candidate', candidateId);
      const row = await store.findStrategyCandidate(scope.clientId, candidateId);
      if (!row) throw new NotFoundError('lab strategy candidate', candidateId);
      const evaluations = await store.listStrategyCandidateEvaluations([candidateId]);
      return mapStrategyCandidateRow(row, evaluations.get(candidateId) ?? []);
    },

    async listStrategyCandidates(scope, scenarioId) {
      assertScope(scope);
      if (scenarioId !== undefined) assertUuidShape('lab scenario', scenarioId);
      const rows = await store.listStrategyCandidates(scope.clientId, scenarioId);
      const evaluations = await store.listStrategyCandidateEvaluations(rows.map((r) => r.candidate_id));
      return rows.map((row) => mapStrategyCandidateRow(row, evaluations.get(row.candidate_id) ?? []));
    },

    async appendStrategyCandidateEvaluation(scope, candidateId, summary) {
      assertScope(scope);
      const candidate = await this.getStrategyCandidate(scope, candidateId);
      if (candidate.status === 'selected' || candidate.status === 'rejected') {
        throw new InvalidRequestError(`lab strategy candidate ${candidateId} is terminal (${candidate.status}) — evaluations append only on non-terminal candidates`);
      }
      if (!isUuid(summary.runId)) {
        throw new InvalidRequestError('summary.runId must be a UUID');
      }
      if (!Array.isArray(summary.uncertaintyInterval) || summary.uncertaintyInterval.length !== 2
          || !Number.isFinite(summary.uncertaintyInterval[0]) || !Number.isFinite(summary.uncertaintyInterval[1])
          || summary.uncertaintyInterval[1] < summary.uncertaintyInterval[0]) {
        throw new InvalidRequestError('summary.uncertaintyInterval must be a [low, high] pair of finite numbers with high ≥ low (§13)');
      }
      for (const field of ['reward', 'ensembleAgreement', 'oodScore', 'seedRobustness'] as const) {
        if (!Number.isFinite(summary[field])) {
          throw new InvalidRequestError(`summary.${field} must be a finite number`);
        }
      }
      await store.insertStrategyCandidateEvaluation(scope.clientId, candidateId, summary);
      if (candidate.status === 'draft') {
        await store.updateStrategyCandidateStatus(scope.clientId, candidateId, 'evaluated');
      }
      return this.getStrategyCandidate(scope, candidateId);
    },

    async setStrategyCandidateStatus(scope, candidateId, status) {
      assertScope(scope);
      const candidate = await this.getStrategyCandidate(scope, candidateId);
      if (candidate.status === 'selected' || candidate.status === 'rejected') {
        throw new InvalidRequestError(`lab strategy candidate ${candidateId} is terminal (${candidate.status})`);
      }
      if (status === 'selected' && candidate.status !== 'evaluated') {
        throw new InvalidRequestError(`lab strategy candidate ${candidateId} is ${candidate.status} — only an evaluated candidate can be selected`);
      }
      const row = await store.updateStrategyCandidateStatus(scope.clientId, candidateId, status);
      if (!row) throw new NotFoundError('lab strategy candidate', candidateId);
      return this.getStrategyCandidate(scope, candidateId);
    },

    // --- Organization candidates (the same lifecycle discipline) ---------

    async createOrganizationCandidate(input) {
      assertScope(input.scope);
      const scenario = await requireLatestScenario(input.scope, input.scenarioId);
      if (input.declaration === null || typeof input.declaration !== 'object') {
        throw new InvalidRequestError('declaration must be an object');
      }
      if (!Array.isArray(input.declaration.agentBodyVersions) || input.declaration.agentBodyVersions.length < 1) {
        throw new InvalidRequestError('declaration.agentBodyVersions must list at least one agent-body version reference (§14)');
      }
      const organizationCandidateId = deps.ids.newId();
      await store.insertOrganizationCandidate({
        organizationCandidateId,
        scenarioId: input.scenarioId,
        scenarioVersion: scenario.scenarioVersion,
        scope: input.scope,
        declaration: input.declaration,
      });
      return this.getOrganizationCandidate(input.scope, organizationCandidateId);
    },

    async getOrganizationCandidate(scope, organizationCandidateId) {
      assertScope(scope);
      assertUuidShape('lab organization candidate', organizationCandidateId);
      const row = await store.findOrganizationCandidate(scope.clientId, organizationCandidateId);
      if (!row) throw new NotFoundError('lab organization candidate', organizationCandidateId);
      const evaluations = await store.listOrganizationCandidateEvaluations([organizationCandidateId]);
      return mapOrganizationCandidateRow(row, evaluations.get(organizationCandidateId) ?? []);
    },

    async listOrganizationCandidates(scope, scenarioId) {
      assertScope(scope);
      if (scenarioId !== undefined) assertUuidShape('lab scenario', scenarioId);
      const rows = await store.listOrganizationCandidates(scope.clientId, scenarioId);
      const evaluations = await store.listOrganizationCandidateEvaluations(rows.map((r) => r.organization_candidate_id));
      return rows.map((row) => mapOrganizationCandidateRow(row, evaluations.get(row.organization_candidate_id) ?? []));
    },

    async appendOrganizationCandidateEvaluation(scope, organizationCandidateId, summary) {
      assertScope(scope);
      const candidate = await this.getOrganizationCandidate(scope, organizationCandidateId);
      if (candidate.status === 'selected' || candidate.status === 'rejected') {
        throw new InvalidRequestError(`lab organization candidate ${organizationCandidateId} is terminal (${candidate.status}) — evaluations append only on non-terminal candidates`);
      }
      if (!isUuid(summary.runId)) {
        throw new InvalidRequestError('summary.runId must be a UUID');
      }
      if (!Array.isArray(summary.uncertaintyInterval) || summary.uncertaintyInterval.length !== 2
          || !Number.isFinite(summary.uncertaintyInterval[0]) || !Number.isFinite(summary.uncertaintyInterval[1])
          || summary.uncertaintyInterval[1] < summary.uncertaintyInterval[0]) {
        throw new InvalidRequestError('summary.uncertaintyInterval must be a [low, high] pair of finite numbers with high ≥ low (§13)');
      }
      for (const field of ['reward', 'ensembleAgreement', 'oodScore', 'seedRobustness'] as const) {
        if (!Number.isFinite(summary[field])) {
          throw new InvalidRequestError(`summary.${field} must be a finite number`);
        }
      }
      await store.insertOrganizationCandidateEvaluation(scope.clientId, organizationCandidateId, summary);
      if (candidate.status === 'draft') {
        await store.updateOrganizationCandidateStatus(scope.clientId, organizationCandidateId, 'evaluated');
      }
      return this.getOrganizationCandidate(scope, organizationCandidateId);
    },

    async setOrganizationCandidateStatus(scope, organizationCandidateId, status) {
      assertScope(scope);
      const candidate = await this.getOrganizationCandidate(scope, organizationCandidateId);
      if (candidate.status === 'selected' || candidate.status === 'rejected') {
        throw new InvalidRequestError(`lab organization candidate ${organizationCandidateId} is terminal (${candidate.status})`);
      }
      if (status === 'selected' && candidate.status !== 'evaluated') {
        throw new InvalidRequestError(`lab organization candidate ${organizationCandidateId} is ${candidate.status} — only an evaluated candidate can be selected`);
      }
      const row = await store.updateOrganizationCandidateStatus(scope.clientId, organizationCandidateId, status);
      if (!row) throw new NotFoundError('lab organization candidate', organizationCandidateId);
      return this.getOrganizationCandidate(scope, organizationCandidateId);
    },

    // --- Capability candidates -------------------------------------------

    async createCapabilityCandidate(input) {
      assertScope(input.scope);
      if (input.contract === null || typeof input.contract !== 'object') {
        throw new InvalidRequestError('contract must be an object');
      }
      for (const field of ['inputSchemaRef', 'outputSchemaRef', 'qualityEvaluatorRef', 'provenance', 'simulatorImplementationRef', 'realImplementationRef'] as const) {
        const value = (input.contract as Record<string, unknown>)[field];
        if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
          throw new InvalidRequestError(`contract.${field} must be a 1-256 char string`);
        }
      }
      if (!Number.isFinite(input.contract.costUnits) || input.contract.costUnits < 0) {
        throw new InvalidRequestError('contract.costUnits must be a finite number ≥ 0');
      }
      if (!Number.isFinite(input.contract.latencyBoundMs) || input.contract.latencyBoundMs < 0) {
        throw new InvalidRequestError('contract.latencyBoundMs must be a finite number ≥ 0');
      }
      const capabilityCandidateId = deps.ids.newId();
      await store.insertCapabilityCandidate({
        capabilityCandidateId,
        scope: input.scope,
        contract: input.contract,
      });
      return this.getCapabilityCandidate(input.scope, capabilityCandidateId);
    },

    async getCapabilityCandidate(scope, capabilityCandidateId) {
      assertScope(scope);
      assertUuidShape('lab capability candidate', capabilityCandidateId);
      const row = await store.findCapabilityCandidate(scope.clientId, capabilityCandidateId);
      if (!row) throw new NotFoundError('lab capability candidate', capabilityCandidateId);
      return mapCapabilityCandidateRow(row);
    },

    async listCapabilityCandidates(scope) {
      assertScope(scope);
      const rows = await store.listCapabilityCandidates(scope.clientId);
      return rows.map((row) => mapCapabilityCandidateRow(row));
    },

    async setCapabilityCandidateStatus(scope, capabilityCandidateId, status) {
      assertScope(scope);
      const candidate = await this.getCapabilityCandidate(scope, capabilityCandidateId);
      if (candidate.status === 'rejected') {
        throw new InvalidRequestError(`lab capability candidate ${capabilityCandidateId} is terminal (rejected)`);
      }
      const legal: Record<string, string[]> = {
        declared: ['simulation_verified', 'rejected'],
        simulation_verified: ['real_verified', 'rejected'],
        real_verified: ['rejected'],
      };
      if (!(legal[candidate.status] ?? []).includes(status)) {
        throw new InvalidRequestError(`lab capability candidate transition ${candidate.status} → ${status} is not legal`);
      }
      const row = await store.updateCapabilityCandidateStatus(scope.clientId, capabilityCandidateId, status);
      if (!row) throw new NotFoundError('lab capability candidate', capabilityCandidateId);
      return this.getCapabilityCandidate(scope, capabilityCandidateId);
    },

    // --- Calibration records ----------------------------------------------

    async createCalibrationRecord(input) {
      assertScope(input.scope);
      if (typeof input.worldModelVersion !== 'string' || input.worldModelVersion.length < 1 || input.worldModelVersion.length > 128) {
        throw new InvalidRequestError('worldModelVersion must be a 1-128 char string');
      }
      // The same-client references (uniform NotFound, no oracle).
      const candidate = await this.getStrategyCandidate(input.scope, input.strategyCandidateId);
      const run = await this.getRun(input.scope, input.runId);
      // The factuality of the prediction block is validated against the
      // run's mode (§3/§10).
      assertValidLabFactualityForMode(input.simulatedPrediction.factuality, run.timeMachine.mode);
      if (!isUuid(input.realOutcome.referenceId)) {
        throw new InvalidRequestError('realOutcome.referenceId must be a UUID (the OPAQUE authority anchor)');
      }
      if (typeof input.realOutcome.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(input.realOutcome.observedAt)) {
        throw new InvalidRequestError('realOutcome.observedAt must be an ISO 8601 UTC timestamp');
      }
      const calibrationRecordId = deps.ids.newId();
      await store.insertCalibrationRecord({
        calibrationRecordId,
        scope: input.scope,
        worldModelVersion: input.worldModelVersion,
        strategyCandidateId: candidate.candidateId,
        runId: run.runId,
        simulatedPrediction: input.simulatedPrediction,
        realOutcome: input.realOutcome,
        predictionError: input.predictionError,
        environmentState: input.environmentState,
        observedRegime: input.observedRegime,
      });
      return this.getCalibrationRecord(input.scope, calibrationRecordId);
    },

    async getCalibrationRecord(scope, calibrationRecordId) {
      assertScope(scope);
      assertUuidShape('lab calibration record', calibrationRecordId);
      const row = await store.findCalibrationRecord(scope.clientId, calibrationRecordId);
      if (!row) throw new NotFoundError('lab calibration record', calibrationRecordId);
      return mapCalibrationRecordRow(row);
    },

    async listCalibrationRecords(scope, worldModelVersion) {
      assertScope(scope);
      const rows = await store.listCalibrationRecords(scope.clientId, worldModelVersion);
      return rows.map((row) => mapCalibrationRecordRow(row));
    },

    async applyCalibrationRecord(scope, calibrationRecordId, calibrationUpdateVersion) {
      assertScope(scope);
      const record = await this.getCalibrationRecord(scope, calibrationRecordId);
      if (record.status !== 'recorded') {
        throw new InvalidRequestError(`lab calibration record ${calibrationRecordId} is ${record.status} — only a recorded calibration can be applied`);
      }
      if (typeof calibrationUpdateVersion !== 'string' || calibrationUpdateVersion.length < 1 || calibrationUpdateVersion.length > 128 || calibrationUpdateVersion === 'pending') {
        throw new InvalidRequestError('calibrationUpdateVersion must be a 1-128 char string (not the pending sentinel)');
      }
      const row = await store.applyCalibrationRecord(scope.clientId, calibrationRecordId, calibrationUpdateVersion);
      if (!row) throw new NotFoundError('lab calibration record', calibrationRecordId);
      return this.getCalibrationRecord(scope, calibrationRecordId);
    },
  };
}
