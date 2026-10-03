/**
 * /lab-capabilities module implementation (LAB-013 — the Capability
 * Engine + Arena Adapter).
 *
 * THE ORCHESTRATION ONLY: this module composes the LabCapabilitiesStore
 * (the migration-067 tables) with the PURE contract guards of
 * validation.ts and the TWO declared structural ports (the ARENA port +
 * the quality-evaluator port — the LAB-011 /ai-runtime structural-port
 * precedent, wired at the composition root; test doubles satisfy the
 * same contracts).
 *
 * THE §17 FLOW, staged exactly (one append-only record per stage, each
 * carrying its actor and its closed state):
 *
 *   capability_gap        detectCapabilityGap         (born open; the strategy + the required action shape cited OPAQUELY)
 *   capability_contract   deriveCapabilityContract     (open → contracted; the §16-shaped requirement + the REQUIRED quality evaluator)
 *   value_estimate        recordCapabilityValueEstimate (recorded → superseded on revision — a revision is a NEW record)
 *   governed_arena_request createCapabilityRequest → dispatchCapabilityRequest (pending → completed/failed via the STRUCTURAL PORT; the provider outcome is the honest echo)
 *   human_or_provider_result recordProviderCapabilityResult / recordHumanPlaneCapabilityResult (append-only outright; the granted rights are recorded DATA, never assumed)
 *   verification          verifyCapabilityResult       (runs the DECLARED evaluator; the verdict from the closed vocabulary; append-only outright)
 *   capability_version    insertCapabilityVersion      (the §16 registry; the acquisition path cites ONLY a passing verification — the DB trigger backstop; the gap advances contracted → resolved)
 *   simulation            recordCapabilitySimulation   (the OPAQUE /lab run citation + the closed outcome)
 *   real_test             recordCapabilityRealTest     (the OPAQUE real-authority citation + the closed outcome)
 *
 * NO SECOND MARKETPLACE AUTHORITY: the dispatch carries the
 * CALLER-DECLARED provider target (adapter key + connection id +
 * operation — DATA) through the arena port; zero selection, ranking or
 * pricing logic exists here. THE HUMAN-PLANE BOUNDARY: the human-plane
 * result cites the canonical plane OPAQUELY; a pending request may be
 * fulfilled via the human plane (advancing to completed with the
 * provider echo honestly null) — human availability is never a
 * prerequisite for any autonomous path.
 *
 * THE SCOPE DISCIPLINE (§22): every read resolves foreign/unknown scope
 * to the uniform NotFound (no existence oracle) — exactly the /lab and
 * /lab-agent-body house pattern.
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  LabCapabilityDeclaration,
  LabCapabilityOrigin,
  LabCapabilityRecord,
  LabCapabilityVersionRecord,
  LabCapabilitiesModuleApi,
  LabCapabilitiesModuleDeps,
  LabCapabilitiesScope,
} from '../public.ts';
import { parseLabCapabilityVersionReference } from '../public.ts';
import {
  assertValidLabCapabilityActor,
  assertValidLabCapabilityAdapterKey,
  assertValidLabCapabilityConstraints,
  assertValidLabCapabilityCost,
  assertValidLabCapabilityDeclarationInput,
  assertValidLabCapabilityDispatchProvenance,
  assertValidLabCapabilityEvidence,
  assertValidLabCapabilityGrantedRights,
  assertValidLabCapabilityHumanPlaneCitation,
  assertValidLabCapabilityImplementation,
  assertValidLabCapabilityImplementationReference,
  assertValidLabCapabilityLatency,
  assertValidLabCapabilityLatencyDeadlineMs,
  assertValidLabCapabilityQualityEvaluator,
  assertValidLabCapabilityRealTestCitation,
  assertValidLabCapabilityRequestedRights,
  assertValidLabCapabilityRequirements,
  assertValidLabCapabilityRequiredAction,
  assertValidLabCapabilitySchema,
  assertValidLabCapabilityStrategyCitation,
  assertValidLabCapabilityLinkOutcome,
  assertValidVersionChainBound,
  assertValidUuidShape,
  isUuidShape,
} from './validation.ts';
import {
  LabCapabilitiesStore,
  mapContractRow,
  mapEstimateRow,
  mapGapRow,
  mapRealTestRow,
  mapRequestRow,
  mapResultRow,
  mapSimulationRow,
  mapVerificationRow,
  mapVersionRow,
} from './capabilities-store.ts';

function assertScope(scope: LabCapabilitiesScope): void {
  if (scope === null || typeof scope !== 'object') {
    throw new InvalidRequestError('scope must be an object');
  }
  if (!isUuidShape(String(scope.agencyId)) || !isUuidShape(String(scope.clientId))) {
    throw new InvalidRequestError('scope.agencyId and scope.clientId must be agency/client ids');
  }
  if (scope.workspaceId !== undefined && scope.workspaceId !== null && !isUuidShape(String(scope.workspaceId))) {
    throw new InvalidRequestError('scope.workspaceId must be a workspace id or null');
  }
}

function assertUuidResource(resource: string, id: string): void {
  if (!isUuidShape(id)) {
    throw new NotFoundError(resource, id);
  }
}

function boundText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export function createLabCapabilitiesModule(deps: LabCapabilitiesModuleDeps): LabCapabilitiesModuleApi {
  if (deps.arena === null || typeof deps.arena !== 'object') {
    throw new InvalidRequestError('deps.arena must be a LabCapabilitiesArenaPort');
  }
  if (typeof deps.arena.listRegisteredAdapters !== 'function' || typeof deps.arena.executeMutation !== 'function') {
    throw new InvalidRequestError('deps.arena must be a LabCapabilitiesArenaPort');
  }
  if (deps.evaluator === null || typeof deps.evaluator !== 'object' || typeof deps.evaluator.evaluate !== 'function') {
    throw new InvalidRequestError('deps.evaluator must be a LabCapabilityQualityEvaluatorPort');
  }

  const arena = deps.arena;
  const evaluator = deps.evaluator;
  const store = new LabCapabilitiesStore(deps.db, deps.clock, deps.ids);

  const withTx = <T>(body: (txStore: LabCapabilitiesStore) => Promise<T>): Promise<T> =>
    deps.db.transaction((tx) => body(new LabCapabilitiesStore(tx, deps.clock, deps.ids)));

  // --- The scope-fenced loaders (the uniform NotFound discipline) ---

  const requireGap = async (scope: LabCapabilitiesScope, gapId: string) => {
    assertUuidResource('lab capability gap', gapId);
    const row = await store.findGap(scope.clientId, gapId);
    if (row === null) throw new NotFoundError('lab capability gap', gapId);
    return row;
  };

  const requireContract = async (scope: LabCapabilitiesScope, contractId: string) => {
    assertUuidResource('lab capability contract', contractId);
    const row = await store.findContract(scope.clientId, contractId);
    if (row === null) throw new NotFoundError('lab capability contract', contractId);
    return row;
  };

  const requireEstimate = async (scope: LabCapabilitiesScope, estimateId: string) => {
    assertUuidResource('lab capability value estimate', estimateId);
    const row = await store.findEstimate(scope.clientId, estimateId);
    if (row === null) throw new NotFoundError('lab capability value estimate', estimateId);
    return row;
  };

  const requireRequest = async (scope: LabCapabilitiesScope, requestId: string) => {
    assertUuidResource('lab capability request', requestId);
    const row = await store.findRequest(scope.clientId, requestId);
    if (row === null) throw new NotFoundError('lab capability request', requestId);
    return row;
  };

  const requireResult = async (scope: LabCapabilitiesScope, resultId: string) => {
    assertUuidResource('lab capability result', resultId);
    const row = await store.findResult(scope.clientId, resultId);
    if (row === null) throw new NotFoundError('lab capability result', resultId);
    return row;
  };

  const requireVerification = async (scope: LabCapabilitiesScope, verificationId: string) => {
    assertUuidResource('lab capability verification', verificationId);
    const row = await store.findVerification(scope.clientId, verificationId);
    if (row === null) throw new NotFoundError('lab capability verification', verificationId);
    return row;
  };

  const requireLatestVersion = async (scope: LabCapabilitiesScope, capabilityId: string) => {
    assertUuidResource('lab capability', capabilityId);
    const row = await store.findLatestVersion(scope.clientId, capabilityId);
    if (row === null) throw new NotFoundError('lab capability', capabilityId);
    return row;
  };

  const requireVersion = async (scope: LabCapabilitiesScope, capabilityId: string, capabilityVersion: number) => {
    assertUuidResource('lab capability', capabilityId);
    const row = await store.findVersion(scope.clientId, capabilityId, capabilityVersion);
    if (row === null) {
      throw new NotFoundError(`lab capability version ${capabilityId}#v${capabilityVersion}`, capabilityId);
    }
    return row;
  };

  const toVersionRecord = async (row: Awaited<ReturnType<typeof store.findVersion>>): Promise<LabCapabilityVersionRecord> =>
    mapVersionRow(row!, await store.findVerificationState(row!));

  // --- The §16 declaration guard (shared by insert + correct) ---

  const assertValidDeclaration = (declaration: LabCapabilityDeclaration): void => {
    assertValidLabCapabilityDeclarationInput(declaration, 'declaration');
    assertValidLabCapabilitySchema(declaration.inputSchema, 'declaration.inputSchema');
    assertValidLabCapabilitySchema(declaration.outputSchema, 'declaration.outputSchema');
    assertValidLabCapabilityConstraints(declaration.constraints, 'declaration.constraints');
    assertValidLabCapabilityQualityEvaluator(declaration.qualityEvaluator, 'declaration.qualityEvaluator');
    assertValidLabCapabilityCost(declaration.cost, 'declaration.cost');
    assertValidLabCapabilityLatency(declaration.latency, 'declaration.latency');
    assertValidLabCapabilityImplementation(declaration.implementation, 'declaration.implementation');
    assertValidLabCapabilityImplementationReference(declaration.simulatorImplementation, 'declaration.simulatorImplementation');
    assertValidLabCapabilityImplementationReference(declaration.realImplementation, 'declaration.realImplementation');
    assertValidLabCapabilityRequirements(declaration.requirements, 'declaration.requirements');
  };

  return {
    // --- Stage 1: the capability gap ---

    async detectCapabilityGap(input) {
      assertScope(input.scope);
      assertValidLabCapabilityStrategyCitation(input.strategyCitation, 'strategyCitation');
      assertValidLabCapabilityRequiredAction(input.requiredAction, 'requiredAction');
      if (typeof input.rationale !== 'string' || input.rationale.length < 1 || input.rationale.length > 1024) {
        throw new InvalidRequestError('rationale must be a 1-1024 char string');
      }
      const detectionActor = assertValidLabCapabilityActor(input.detectionActor, 'detectionActor');
      const row = await store.insertGap({
        gapId: store.newId(),
        scope: input.scope,
        detectionActor,
        strategyCitation: input.strategyCitation,
        requiredAction: input.requiredAction,
        rationale: input.rationale,
      });
      return mapGapRow(row);
    },

    async getCapabilityGap(scope, gapId) {
      assertScope(scope);
      return mapGapRow(await requireGap(scope, gapId));
    },

    async listCapabilityGaps(scope, filter) {
      assertScope(scope);
      const rows = await store.listGaps(scope.clientId, filter?.status ?? null);
      return rows.map(mapGapRow);
    },

    async abandonCapabilityGap(scope, gapId) {
      assertScope(scope);
      const gap = await requireGap(scope, gapId);
      if (gap.status !== 'open' && gap.status !== 'contracted') {
        throw new InvalidRequestError(`lab capability gap ${gapId} is ${gap.status} — only an open or contracted gap can be abandoned`);
      }
      const row = await store.updateGapStatus(scope.clientId, gapId, 'abandoned');
      if (row === null) throw new NotFoundError('lab capability gap', gapId);
      return mapGapRow(row);
    },

    // --- Stage 2: the capability contract ---

    async deriveCapabilityContract(input) {
      assertScope(input.scope);
      const gap = await requireGap(input.scope, input.gapId);
      if (gap.status !== 'open') {
        throw new InvalidRequestError(`lab capability gap ${input.gapId} is ${gap.status} — only an open gap can be contracted`);
      }
      assertValidLabCapabilitySchema(input.inputSchema, 'inputSchema');
      assertValidLabCapabilitySchema(input.outputSchema, 'outputSchema');
      assertValidLabCapabilityConstraints(input.constraints, 'constraints');
      assertValidLabCapabilityQualityEvaluator(input.qualityEvaluator, 'qualityEvaluator');
      assertValidLabCapabilityCost(input.costCeiling, 'costCeiling');
      assertValidLabCapabilityLatencyDeadlineMs(input.latencyCeilingMs, 'latencyCeilingMs');
      assertValidLabCapabilityRequirements(input.requirements, 'requirements');
      const actor = assertValidLabCapabilityActor(input.actor, 'actor');

      return withTx(async (txStore) => {
        const contractRow = await txStore.insertContract({
          contractId: txStore.newId(),
          scope: input.scope,
          gapId: input.gapId,
          actor,
          inputSchema: input.inputSchema,
          outputSchema: input.outputSchema,
          constraints: input.constraints,
          qualityEvaluator: input.qualityEvaluator,
          costCeiling: input.costCeiling,
          latencyCeiling: { deadlineMs: input.latencyCeilingMs },
          requirements: input.requirements,
        });
        const gapRow = await txStore.updateGapStatus(input.scope.clientId, input.gapId, 'contracted');
        if (gapRow === null) throw new NotFoundError('lab capability gap', input.gapId);
        return mapContractRow(contractRow);
      });
    },

    async getCapabilityContract(scope, contractId) {
      assertScope(scope);
      return mapContractRow(await requireContract(scope, contractId));
    },

    async listCapabilityContracts(scope, filter) {
      assertScope(scope);
      const rows = await store.listContracts(scope.clientId, filter?.gapId ?? null);
      return rows.map(mapContractRow);
    },

    async withdrawCapabilityContract(scope, contractId) {
      assertScope(scope);
      const contract = await requireContract(scope, contractId);
      if (contract.status !== 'derived') {
        throw new InvalidRequestError(`lab capability contract ${contractId} is ${contract.status} — only a derived contract can be withdrawn`);
      }
      const row = await store.updateContractStatus(scope.clientId, contractId, 'withdrawn');
      if (row === null) throw new NotFoundError('lab capability contract', contractId);
      return mapContractRow(row);
    },

    // --- Stage 3: the value estimate ---

    async recordCapabilityValueEstimate(input) {
      assertScope(input.scope);
      const contract = await requireContract(input.scope, input.contractId);
      if (contract.status !== 'derived') {
        throw new InvalidRequestError(`lab capability contract ${input.contractId} is ${contract.status} — estimates bind a derived contract`);
      }
      const figures = input.figures;
      if (figures === null || typeof figures !== 'object') {
        throw new InvalidRequestError('figures must be an object');
      }
      for (const [label, value] of [
        ['figures.estimatedValueUnits', figures.estimatedValueUnits],
        ['figures.expectedQualityLift', figures.expectedQualityLift],
        ['figures.estimatedCostCeiling', figures.estimatedCostCeiling],
      ] as const) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new InvalidRequestError(`${label} must be a finite number >= 0`);
        }
      }
      for (const [label, value] of [
        ['figures.uncertainty', figures.uncertainty],
        ['figures.basis', figures.basis],
      ] as const) {
        if (typeof value !== 'string' || value.length < 1 || value.length > (label.endsWith('uncertainty') ? 512 : 1024)) {
          throw new InvalidRequestError(`${label} must be a bounded string`);
        }
      }
      const actor = assertValidLabCapabilityActor(input.actor, 'actor');

      return withTx(async (txStore) => {
        // A revision supersedes the prior RECORDED estimate in the same
        // transaction (never an in-place rewrite).
        await txStore.supersedeRecordedEstimates(input.contractId);
        const row = await txStore.insertEstimate({
          estimateId: txStore.newId(),
          scope: input.scope,
          contractId: input.contractId,
          actor,
          estimatedValueUnits: figures.estimatedValueUnits,
          expectedQualityLift: figures.expectedQualityLift,
          estimatedCostCeiling: figures.estimatedCostCeiling,
          uncertainty: figures.uncertainty,
          basis: figures.basis,
        });
        return mapEstimateRow(row);
      });
    },

    async getCapabilityValueEstimate(scope, estimateId) {
      assertScope(scope);
      return mapEstimateRow(await requireEstimate(scope, estimateId));
    },

    async listCapabilityValueEstimates(scope, filter) {
      assertScope(scope);
      const rows = await store.listEstimates(scope.clientId, filter?.contractId ?? null);
      return rows.map(mapEstimateRow);
    },

    // --- Stage 4: the governed Arena request ---

    async createCapabilityRequest(input) {
      assertScope(input.scope);
      const gap = await requireGap(input.scope, input.gapId);
      if (gap.status !== 'contracted') {
        throw new InvalidRequestError(`lab capability gap ${input.gapId} is ${gap.status} — a governed request binds a contracted gap`);
      }
      const contract = await requireContract(input.scope, input.contractId);
      if (contract.gap_id !== input.gapId) {
        throw new InvalidRequestError('the cited contract must belong to the cited gap (the chain must cohere)');
      }
      if (contract.status !== 'derived') {
        throw new InvalidRequestError(`lab capability contract ${input.contractId} is ${contract.status} — a governed request binds a derived contract`);
      }
      const estimate = await requireEstimate(input.scope, input.estimateId);
      if (estimate.contract_id !== input.contractId) {
        throw new InvalidRequestError('the cited estimate must belong to the cited contract (the chain must cohere)');
      }
      if (estimate.status !== 'recorded') {
        throw new InvalidRequestError(`lab capability value estimate ${input.estimateId} is ${estimate.status} — a governed request binds the recorded estimate`);
      }
      assertValidLabCapabilityAdapterKey(input.adapterKey, 'adapterKey');
      assertValidUuidShape('connectionId', input.connectionId);
      if (typeof input.operation !== 'string' || input.operation.length < 1 || input.operation.length > 128) {
        throw new InvalidRequestError('operation must be a 1-128 char string');
      }
      if (input.requestParameters === null || typeof input.requestParameters !== 'object' || Array.isArray(input.requestParameters)) {
        throw new InvalidRequestError('requestParameters must be an object');
      }
      assertValidLabCapabilityRequestedRights(input.requestedRights, 'requestedRights');
      const actor = assertValidLabCapabilityActor(input.actor, 'actor');

      const row = await store.insertRequest({
        requestId: store.newId(),
        scope: input.scope,
        gapId: input.gapId,
        contractId: input.contractId,
        estimateId: input.estimateId,
        actor,
        adapterKey: input.adapterKey,
        connectionId: input.connectionId,
        operation: input.operation,
        requestParameters: input.requestParameters,
        requestedRights: input.requestedRights,
      });
      return mapRequestRow(row);
    },

    async dispatchCapabilityRequest(input) {
      assertScope(input.scope);
      assertValidLabCapabilityDispatchProvenance(input.provenance, 'provenance');
      const request = await requireRequest(input.scope, input.requestId);
      if (request.status !== 'pending') {
        throw new InvalidRequestError(`lab capability request ${input.requestId} is ${request.status} — only a pending request can be dispatched`);
      }

      // THE GOVERNED DISPATCH: through the STRUCTURAL PORT ONLY (the
      // existing /integrations fail-closed gates). The port never throws
      // for invocation-level outcomes; a transport-level throw is caught
      // and recorded as the honest failed state — never a fabricated
      // success.
      let outcome: Awaited<ReturnType<typeof arena.executeMutation>>;
      try {
        outcome = await arena.executeMutation(
          {
            connectionId: request.connection_id,
            operation: request.operation,
            parameters: request.request_parameters as Readonly<Record<string, unknown>>,
          },
          input.provenance,
        );
      } catch (error) {
        const row = await store.advanceRequest({
          clientId: input.scope.clientId,
          requestId: input.requestId,
          status: 'failed',
          providerOk: false,
          providerRecordId: null,
          providerError: boundText(`port error: ${String(error)}`, 512),
          dispatchedAt: store.nowIso(),
        });
        if (row === null) throw new NotFoundError('lab capability request', input.requestId);
        return mapRequestRow(row);
      }

      const ok = outcome?.ok === true;
      const row = await store.advanceRequest({
        clientId: input.scope.clientId,
        requestId: input.requestId,
        status: ok ? 'completed' : 'failed',
        providerOk: ok,
        providerRecordId: ok ? (outcome.providerRecordId ?? null) : null,
        providerError: ok ? null : boundText(String(outcome?.error ?? 'provider mutation refused'), 512),
        dispatchedAt: store.nowIso(),
      });
      if (row === null) throw new NotFoundError('lab capability request', input.requestId);
      return mapRequestRow(row);
    },

    async getCapabilityRequest(scope, requestId) {
      assertScope(scope);
      return mapRequestRow(await requireRequest(scope, requestId));
    },

    async listCapabilityRequests(scope, filter) {
      assertScope(scope);
      const rows = await store.listRequests(scope.clientId, filter?.gapId ?? null, filter?.status ?? null);
      return rows.map(mapRequestRow);
    },

    async cancelCapabilityRequest(scope, requestId) {
      assertScope(scope);
      const request = await requireRequest(scope, requestId);
      if (request.status !== 'pending') {
        throw new InvalidRequestError(`lab capability request ${requestId} is ${request.status} — only a pending request can be cancelled`);
      }
      const row = await store.advanceRequest({
        clientId: scope.clientId,
        requestId,
        status: 'cancelled',
        providerOk: null,
        providerRecordId: null,
        providerError: null,
        dispatchedAt: null,
      });
      if (row === null) throw new NotFoundError('lab capability request', requestId);
      return mapRequestRow(row);
    },

    // --- Stage 5: the human/provider result ---

    async recordProviderCapabilityResult(input) {
      assertScope(input.scope);
      const request = await requireRequest(input.scope, input.requestId);
      if (request.status !== 'completed' || request.provider_ok !== true) {
        throw new InvalidRequestError(
          `lab capability request ${input.requestId} is ${request.status}${request.provider_ok === true ? '' : ' (providerOk: ' + String(request.provider_ok) + ')'} — a provider result binds a completed successful dispatch`,
        );
      }
      if (input.deliveredArtifact === null || typeof input.deliveredArtifact !== 'object' || Array.isArray(input.deliveredArtifact)) {
        throw new InvalidRequestError('deliveredArtifact must be an object');
      }
      const grantedRights = assertValidLabCapabilityGrantedRights(input.grantedRights, 'grantedRights');

      const row = await store.insertResult({
        resultId: store.newId(),
        scope: input.scope,
        requestId: input.requestId,
        fulfillmentKind: 'provider',
        actor: 'autonomous',
        providerAdapterKey: request.adapter_key,
        providerRecordId: request.provider_record_id,
        humanPlaneCitation: null,
        deliveredArtifact: input.deliveredArtifact,
        grantedRights,
      });
      return mapResultRow(row);
    },

    async recordHumanPlaneCapabilityResult(input) {
      assertScope(input.scope);
      const request = await requireRequest(input.scope, input.requestId);
      if (request.status !== 'pending' && request.status !== 'completed') {
        throw new InvalidRequestError(
          `lab capability request ${input.requestId} is ${request.status} — a human-plane result binds a pending or completed request`,
        );
      }
      assertValidLabCapabilityHumanPlaneCitation(input.humanPlaneCitation, 'humanPlaneCitation');
      if (input.deliveredArtifact === null || typeof input.deliveredArtifact !== 'object' || Array.isArray(input.deliveredArtifact)) {
        throw new InvalidRequestError('deliveredArtifact must be an object');
      }
      const grantedRights = assertValidLabCapabilityGrantedRights(input.grantedRights, 'grantedRights');

      return withTx(async (txStore) => {
        // A pending request fulfilled via the human plane advances to
        // completed in the same transaction — the provider echo stays
        // honestly null (no provider mutation happened).
        if (request.status === 'pending') {
          const advanced = await txStore.advanceRequest({
            clientId: input.scope.clientId,
            requestId: input.requestId,
            status: 'completed',
            providerOk: null,
            providerRecordId: null,
            providerError: null,
            dispatchedAt: null,
          });
          if (advanced === null) throw new NotFoundError('lab capability request', input.requestId);
        }
        const row = await txStore.insertResult({
          resultId: txStore.newId(),
          scope: input.scope,
          requestId: input.requestId,
          fulfillmentKind: 'human_plane',
          actor: 'human',
          providerAdapterKey: null,
          providerRecordId: null,
          humanPlaneCitation: input.humanPlaneCitation,
          deliveredArtifact: input.deliveredArtifact,
          grantedRights,
        });
        return mapResultRow(row);
      });
    },

    async getCapabilityResult(scope, resultId) {
      assertScope(scope);
      return mapResultRow(await requireResult(scope, resultId));
    },

    async listCapabilityResults(scope, filter) {
      assertScope(scope);
      const rows = await store.listResults(scope.clientId, filter?.requestId ?? null);
      return rows.map(mapResultRow);
    },

    // --- Stage 6: the verification ---

    async verifyCapabilityResult(input) {
      assertScope(input.scope);
      const result = await requireResult(input.scope, input.resultId);
      const request = await requireRequest(input.scope, result.request_id);
      const contract = await requireContract(input.scope, request.contract_id);
      const actor = assertValidLabCapabilityActor(input.actor, 'actor');

      // THE DECLARED EVALUATOR (§16): the run uses the CONTRACT's
      // declaration — identity, version and the evaluation contract —
      // against the delivered artifact.
      const outcome = await evaluator.evaluate({
        declaredEvaluator: contract.quality_evaluator as never,
        outputSchema: contract.output_schema as never,
        deliveredArtifact: result.delivered_artifact as Readonly<Record<string, unknown>>,
      });
      if (outcome === null || typeof outcome !== 'object') {
        throw new InvalidRequestError('the quality evaluator must return an evaluation outcome');
      }
      const verdict = outcome.verdict;
      if (
        verdict !== 'pass' &&
        verdict !== 'fail' &&
        verdict !== 'inconclusive'
      ) {
        throw new InvalidRequestError("the evaluator verdict must be one of 'pass', 'fail', 'inconclusive'");
      }
      assertValidLabCapabilityEvidence(outcome.evidence, 'evaluationEvidence');

      const row = await store.insertVerification({
        verificationId: store.newId(),
        scope: input.scope,
        resultId: input.resultId,
        contractId: request.contract_id,
        verdict,
        actor,
        evaluatorId: String((contract.quality_evaluator as Record<string, unknown>)['evaluatorId']),
        evaluatorVersion: String((contract.quality_evaluator as Record<string, unknown>)['evaluatorVersion']),
        evaluationEvidence: outcome.evidence,
      });
      return mapVerificationRow(row);
    },

    async getCapabilityVerification(scope, verificationId) {
      assertScope(scope);
      return mapVerificationRow(await requireVerification(scope, verificationId));
    },

    async listCapabilityVerifications(scope, filter) {
      assertScope(scope);
      const rows = await store.listVerifications(scope.clientId, filter?.resultId ?? null);
      return rows.map(mapVerificationRow);
    },

    // --- Stage 7: the capability version registry ---

    async insertCapabilityVersion(input) {
      assertScope(input.scope);
      assertValidDeclaration(input.declaration);
      const actor = assertValidLabCapabilityActor(input.actor, 'actor');

      let origin: LabCapabilityOrigin = 'first_party_declared';
      let sourceVerificationId: string | null = null;
      let sourceGapId: string | null = null;

      if (input.sourceVerificationId !== undefined && input.sourceVerificationId !== null) {
        // THE ACQUISITION PATH: resolve the chain verification → result →
        // request; derive the gap + the origin from the chain (the DB
        // citation trigger is the backstop — only a PASSING verification
        // in the same scope can be cited).
        assertValidUuidShape('sourceVerificationId', input.sourceVerificationId);
        const verification = await requireVerification(input.scope, input.sourceVerificationId);
        if (verification.verdict !== 'pass') {
          throw new InvalidRequestError(
            `lab capability verification ${input.sourceVerificationId} verdict is '${verification.verdict}' — a capability version may cite only a PASSING verification (the unverified-never-presented rule)`,
          );
        }
        const result = await requireResult(input.scope, verification.result_id);
        const request = await requireRequest(input.scope, result.request_id);
        sourceVerificationId = verification.verification_id;
        sourceGapId = request.gap_id;
        origin = result.fulfillment_kind === 'provider' ? 'arena_provider' : 'human_contribution';
        const gap = await requireGap(input.scope, request.gap_id);
        if (gap.status !== 'contracted') {
          throw new InvalidRequestError(
            `lab capability gap ${request.gap_id} is ${gap.status} — an acquired capability version resolves a contracted gap`,
          );
        }
      }

      return withTx(async (txStore) => {
        const versionRow = await txStore.insertVersion({
          capabilityId: txStore.newId(),
          capabilityVersion: 1,
          scope: input.scope,
          capabilityKey: input.declaration.capabilityKey,
          displayName: input.declaration.displayName,
          actor,
          inputSchema: input.declaration.inputSchema,
          outputSchema: input.declaration.outputSchema,
          constraints: input.declaration.constraints,
          qualityEvaluator: input.declaration.qualityEvaluator,
          cost: input.declaration.cost,
          latency: input.declaration.latency,
          origin,
          provenance: { origin, sourceNote: input.declaration.provenanceSourceNote },
          implementation: input.declaration.implementation,
          simulatorImplementation: input.declaration.simulatorImplementation,
          realImplementation: input.declaration.realImplementation,
          requirements: input.declaration.requirements,
          sourceVerificationId,
          sourceGapId,
        });
        if (sourceGapId !== null) {
          const gapRow = await txStore.updateGapStatus(input.scope.clientId, sourceGapId, 'resolved');
          if (gapRow === null) throw new NotFoundError('lab capability gap', sourceGapId);
        }
        return mapVersionRow(versionRow, await txStore.findVerificationState(versionRow));
      });
    },

    async getCapability(scope, capabilityId) {
      assertScope(scope);
      const row = await requireLatestVersion(scope, capabilityId);
      return toVersionRecord(row);
    },

    async getCapabilityByReference(scope, capabilityVersionReference) {
      assertScope(scope);
      const { capabilityId, capabilityVersion } = parseLabCapabilityVersionReference(capabilityVersionReference);
      const row = await requireVersion(scope, capabilityId, capabilityVersion);
      return toVersionRecord(row);
    },

    async listCapabilities(scope, filter) {
      assertScope(scope);
      const rows = await store.listLatestVersions(scope.clientId, filter?.status ?? null);
      const out: LabCapabilityRecord[] = [];
      for (const row of rows) {
        out.push(mapVersionRow(row, await store.findVerificationState(row)));
      }
      return out;
    },

    async listCapabilityVersions(scope, capabilityId) {
      assertScope(scope);
      assertUuidResource('lab capability', capabilityId);
      const rows = await store.listVersions(scope.clientId, capabilityId);
      const out: LabCapabilityVersionRecord[] = [];
      for (const row of rows) {
        out.push(mapVersionRow(row, await store.findVerificationState(row)));
      }
      return out;
    },

    async activateCapability(scope, capabilityId) {
      assertScope(scope);
      const latest = await requireLatestVersion(scope, capabilityId);
      if (latest.status !== 'draft') {
        throw new InvalidRequestError(`lab capability ${capabilityId} is ${latest.status} — only a draft capability can be activated`);
      }
      const row = await store.updateVersionStatus(scope.clientId, capabilityId, Number(latest.capability_version), 'active');
      if (row === null) throw new NotFoundError('lab capability', capabilityId);
      return toVersionRecord(row);
    },

    async retireCapability(scope, capabilityId) {
      assertScope(scope);
      const latest = await requireLatestVersion(scope, capabilityId);
      if (latest.status !== 'active') {
        throw new InvalidRequestError(`lab capability ${capabilityId} is ${latest.status} — only an active capability can be retired`);
      }
      const row = await store.updateVersionStatus(scope.clientId, capabilityId, Number(latest.capability_version), 'retired');
      if (row === null) throw new NotFoundError('lab capability', capabilityId);
      return toVersionRecord(row);
    },

    async correctCapability(input) {
      assertScope(input.scope);
      assertValidDeclaration(input.declaration);
      const actor = assertValidLabCapabilityActor(input.actor, 'actor');
      const latest = await requireLatestVersion(input.scope, input.capabilityId);
      assertValidVersionChainBound(Number(latest.capability_version));
      if (latest.capability_key !== input.declaration.capabilityKey) {
        throw new InvalidRequestError(
          `declaration.capabilityKey '${input.declaration.capabilityKey}' does not match the chain key '${latest.capability_key}' — the chain key is immutable`,
        );
      }
      // A correction is a fresh chain version as draft (the LAB-011
      // correction precedent): the acquisition citations do NOT ride
      // corrections — a corrected version is honestly unverified until
      // new verified evidence exists.
      const row = await store.insertVersion({
        capabilityId: input.capabilityId,
        capabilityVersion: Number(latest.capability_version) + 1,
        scope: input.scope,
        capabilityKey: input.declaration.capabilityKey,
        displayName: input.declaration.displayName,
        actor,
        inputSchema: input.declaration.inputSchema,
        outputSchema: input.declaration.outputSchema,
        constraints: input.declaration.constraints,
        qualityEvaluator: input.declaration.qualityEvaluator,
        cost: input.declaration.cost,
        latency: input.declaration.latency,
        origin: 'first_party_declared',
        provenance: { origin: 'first_party_declared' as LabCapabilityOrigin, sourceNote: input.declaration.provenanceSourceNote },
        implementation: input.declaration.implementation,
        simulatorImplementation: input.declaration.simulatorImplementation,
        realImplementation: input.declaration.realImplementation,
        requirements: input.declaration.requirements,
        sourceVerificationId: null,
        sourceGapId: null,
      });
      return toVersionRecord(row);
    },

    // --- Stage 8: the simulation link ---

    async recordCapabilitySimulation(input) {
      assertScope(input.scope);
      await requireVersion(input.scope, input.capabilityId, input.capabilityVersion);
      if (typeof input.simulationReference !== 'string' || input.simulationReference.length < 1 || input.simulationReference.length > 256) {
        throw new InvalidRequestError('simulationReference must be a 1-256 char string');
      }
      assertValidLabCapabilityLinkOutcome(input.outcome, 'outcome');
      assertValidLabCapabilityEvidence(input.evidence, 'evidence');
      const actor = assertValidLabCapabilityActor(input.actor, 'actor');
      const row = await store.insertSimulation({
        simulationId: store.newId(),
        scope: input.scope,
        capabilityId: input.capabilityId,
        capabilityVersion: input.capabilityVersion,
        actor,
        simulationReference: input.simulationReference,
        outcome: input.outcome,
        evidence: input.evidence,
      });
      return mapSimulationRow(row);
    },

    async listCapabilitySimulations(scope, filter) {
      assertScope(scope);
      const rows = await store.listSimulations(scope.clientId, filter?.capabilityId ?? null);
      return rows.map(mapSimulationRow);
    },

    // --- Stage 9: the real-test link ---

    async recordCapabilityRealTest(input) {
      assertScope(input.scope);
      await requireVersion(input.scope, input.capabilityId, input.capabilityVersion);
      assertValidLabCapabilityRealTestCitation(input.realTestCitation, 'realTestCitation');
      assertValidLabCapabilityLinkOutcome(input.outcome, 'outcome');
      assertValidLabCapabilityEvidence(input.evidence, 'evidence');
      const actor = assertValidLabCapabilityActor(input.actor, 'actor');
      const row = await store.insertRealTest({
        realTestId: store.newId(),
        scope: input.scope,
        capabilityId: input.capabilityId,
        capabilityVersion: input.capabilityVersion,
        actor,
        realTestCitation: input.realTestCitation,
        outcome: input.outcome,
        evidence: input.evidence,
      });
      return mapRealTestRow(row);
    },

    async listCapabilityRealTests(scope, filter) {
      assertScope(scope);
      const rows = await store.listRealTests(scope.clientId, filter?.capabilityId ?? null);
      return rows.map(mapRealTestRow);
    },

    // --- The Arena discovery (READ-ONLY through the structural port) ---

    listArenaProviders() {
      return arena.listRegisteredAdapters();
    },
  };
}
