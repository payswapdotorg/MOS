/**
 * /lab-agent-body module implementation (LAB-011 — the Agent Body
 * Runtime Contract).
 *
 * THE ORCHESTRATION ONLY: this factory composes the LabAgentBodyStore
 * (the migration-063 tables) with the PURE contract guards of
 * validation.ts and the agent-instance runtime of agent-instance.ts —
 * every create/correct/run passes the frozen contract semantics
 * BEFORE touching the store, and the store's guarded UPDATEs + the
 * migration-063 triggers backstop every rule (defense in depth; the
 * DB fences are the authority, the module guards are the honest error
 * surface).
 *
 * THE REGISTRY DISCIPLINE (the LAB-001 scenario / LAB-002 corpus
 * semantics): the body lifecycle transitions apply to the LATEST
 * version row (draft → active → retired, no resurrection); a
 * correction appends a NEW version row as draft (the re-activation
 * gate applies per version); runs bind the EXACT body version the
 * opaque reference cites (which must be ACTIVE — instantiation of a
 * draft/retired body is refused; existing runs keep their recorded
 * version forever).
 *
 * THE RUN DISCIPLINE: runAgentInstance validates the request shape
 * (pure guards — 422 on malformed input), resolves the body version
 * (uniform NotFound for foreign scope — no existence oracle), creates
 * the run row born 'running', resolves the caller-supplied model
 * identity THROUGH THE /ai-RUNTIME PORT (the model authority — never
 * a local registry, never a selection), then hands the bounded loop
 * to the agent-instance runtime. Every terminal state — success AND
 * failure — is an honest recorded record with the append-only event
 * tail.
 *
 * THE SCOPE DISCIPLINE (§22): every read resolves foreign/unknown
 * scope to the uniform NotFound (no existence oracle) — exactly the
 * /lab and /lab-corpus house pattern.
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  LabAgentBodyModuleApi,
  LabAgentBodyModuleDeps,
  LabAgentBodyRecord,
  LabAgentBodyScope,
  LabAgentInstanceRunRecord,
  LabAgentMemoryEntryRecord,
  LabAgentRunEventRecord,
  RunLabAgentInstanceInput,
} from '../public.ts';
import { LAB_AGENT_BODY_MAX_VERSIONS } from '../public.ts';
import { assertValidLabAgentBodyContract, assertValidRunLabAgentInstanceInput, parseLabAgentBodyVersionReference } from './validation.ts';
import { LabAgentBodyStore, mapBodyVersionRow, mapMemoryEntryRow, mapRunRow, mapEventRow } from './agent-body-store.ts';
import { executeAgentInstanceRun } from './agent-instance.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertScope(scope: LabAgentBodyScope): void {
  if (scope === null || typeof scope !== 'object') {
    throw new InvalidRequestError('scope must be an object');
  }
  if (!UUID_PATTERN.test(String(scope.agencyId)) || !UUID_PATTERN.test(String(scope.clientId))) {
    throw new InvalidRequestError('scope.agencyId and scope.clientId must be agency/client ids');
  }
  if (scope.workspaceId !== undefined && scope.workspaceId !== null && !UUID_PATTERN.test(String(scope.workspaceId))) {
    throw new InvalidRequestError('scope.workspaceId must be a workspace id or null');
  }
}

function assertUuidShape(resource: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError(resource, id);
  }
}

/** The public record view of one body-version row. */
function toBodyRecord(mapped: ReturnType<typeof mapBodyVersionRow>): LabAgentBodyRecord {
  return {
    bodyId: mapped.bodyId,
    bodyVersion: mapped.bodyVersion,
    agencyId: mapped.agencyId,
    clientId: mapped.clientId,
    workspaceId: mapped.workspaceId,
    status: mapped.status,
    contract: mapped.contract,
    bodyVersionReference: mapped.bodyVersionReference,
    contractVersion: mapped.contractVersion,
    createdAt: mapped.createdAt,
    updatedAt: mapped.updatedAt,
  };
}

export function createLabAgentBodyModule(deps: LabAgentBodyModuleDeps): LabAgentBodyModuleApi {
  const store = new LabAgentBodyStore(deps.db, deps.clock, deps.ids);

  const requireBodyVersion = async (scope: LabAgentBodyScope, bodyId: string, bodyVersion: number) => {
    const row = await store.findBodyVersion(scope.clientId, bodyId, bodyVersion);
    if (row === null) {
      throw new NotFoundError('lab agent body version', `${bodyId}#v${bodyVersion}`);
    }
    return mapBodyVersionRow(row);
  };

  const requireLatestBody = async (scope: LabAgentBodyScope, bodyId: string) => {
    assertUuidShape('lab agent body', bodyId);
    const row = await store.findLatestBodyVersion(scope.clientId, bodyId);
    if (row === null) {
      throw new NotFoundError('lab agent body', bodyId);
    }
    return mapBodyVersionRow(row);
  };

  return {
    // --- The versioned body registry ---

    async createBody(input) {
      assertScope(input.scope);
      assertValidLabAgentBodyContract(input.contract);
      const row = await store.insertBodyVersion({
        bodyId: store.newId(),
        bodyVersion: 1,
        scope: input.scope,
        status: 'draft',
        contract: input.contract,
      });
      return toBodyRecord(mapBodyVersionRow(row));
    },

    async getBody(scope, bodyId) {
      assertScope(scope);
      return toBodyRecord(await requireLatestBody(scope, bodyId));
    },

    async getBodyByReference(scope, bodyVersionReference) {
      assertScope(scope);
      const { bodyId, bodyVersion } = parseLabAgentBodyVersionReference(bodyVersionReference);
      return toBodyRecord(await requireBodyVersion(scope, bodyId, bodyVersion));
    },

    async listBodies(scope) {
      assertScope(scope);
      const rows = await store.listLatestBodies(scope.clientId);
      return rows.map((row) => toBodyRecord(mapBodyVersionRow(row)));
    },

    async activateBody(scope, bodyId) {
      assertScope(scope);
      const body = await requireLatestBody(scope, bodyId);
      if (body.status !== 'draft') {
        throw new InvalidRequestError(`lab agent body ${bodyId} is ${body.status} — only a draft body can be activated`);
      }
      const row = await store.updateBodyStatus(scope.clientId, bodyId, body.bodyVersion, 'active');
      if (row === null) throw new NotFoundError('lab agent body', bodyId);
      return toBodyRecord(mapBodyVersionRow(row));
    },

    async retireBody(scope, bodyId) {
      assertScope(scope);
      const body = await requireLatestBody(scope, bodyId);
      if (body.status !== 'active') {
        throw new InvalidRequestError(`lab agent body ${bodyId} is ${body.status} — only an active body can be retired`);
      }
      const row = await store.updateBodyStatus(scope.clientId, bodyId, body.bodyVersion, 'retired');
      if (row === null) throw new NotFoundError('lab agent body', bodyId);
      return toBodyRecord(mapBodyVersionRow(row));
    },

    async correctBody(input) {
      assertScope(input.scope);
      assertValidLabAgentBodyContract(input.contract);
      const body = await requireLatestBody(input.scope, input.bodyId);
      if (body.bodyVersion >= LAB_AGENT_BODY_MAX_VERSIONS) {
        throw new InvalidRequestError(`lab agent body ${input.bodyId} has reached the version chain bound (${LAB_AGENT_BODY_MAX_VERSIONS})`);
      }
      // A correction starts a fresh chain as draft (the activation gate
      // applies per version: the corrected version must be re-activated
      // before runs bind it).
      const row = await store.insertBodyVersion({
        bodyId: input.bodyId,
        bodyVersion: body.bodyVersion + 1,
        scope: { agencyId: body.agencyId, clientId: body.clientId, workspaceId: body.workspaceId },
        status: 'draft',
        contract: input.contract,
      });
      return toBodyRecord(mapBodyVersionRow(row));
    },

    // --- Agent Instance execution (the runtime) ---

    async runAgentInstance(input: RunLabAgentInstanceInput): Promise<LabAgentInstanceRunRecord> {
      assertValidRunLabAgentInstanceInput(input);
      assertScope(input.scope);
      const { bodyId, bodyVersion } = parseLabAgentBodyVersionReference(input.bodyVersionReference);
      const body = await requireBodyVersion(input.scope, bodyId, bodyVersion);
      if (body.status !== 'active') {
        throw new InvalidRequestError(
          `lab agent body version ${input.bodyVersionReference} is ${body.status} — only an active body version can be instantiated`,
        );
      }
      if (input.addressedChannel !== undefined && input.addressedChannel !== null) {
        const declared = body.contract.communicationInterface.some((channel) => channel.channelId === input.addressedChannel);
        if (!declared) {
          throw new InvalidRequestError(`addressedChannel '${input.addressedChannel}' is not a channel the body declares`);
        }
      }

      // THE MODEL-IDENTITY RESOLUTION — through the /ai-runtime public
      // port ONLY (the model authority; the identity is DATA selected
      // by the caller, never by this module).
      const model = await deps.aiRuntime.getModel(input.modelRegistryId);
      if (model === null) {
        // The identity does not resolve through the registry: the run
        // record itself carries the honest model_unavailable state.
        const runId = store.newId();
        await store.insertRun({
          runId,
          bodyId,
          bodyVersion,
          scope: input.scope,
          modelRegistryId: input.modelRegistryId,
          modelProviderLabel: 'unresolved',
          modelKey: 'unresolved',
          modelDisplayName: 'unresolved',
          inputMessage: input.inputMessage,
          addressedChannel: input.addressedChannel ?? null,
          startedAtIso: store.nowIso(),
        });
        return executeAgentInstanceRun(
          { store, clock: deps.clock, ids: deps.ids, aiRuntime: deps.aiRuntime },
          {
            runId,
            scope: input.scope,
            body: { bodyId, bodyVersion, contract: body.contract },
            model: {
              modelRegistryId: input.modelRegistryId,
              providerLabel: 'unresolved',
              modelKey: 'unresolved',
              displayName: 'unresolved',
              // The unresolved marker drives the honest model_unavailable
              // terminal failure inside the runtime (a synthetic
              // non-authoritative marker that can never pass the gate).
              status: 'unresolved',
              availabilityState: 'unavailable',
            },
            inputMessage: input.inputMessage,
            addressedChannel: input.addressedChannel ?? null,
          },
          input.backend,
          input.toolExecutor,
        );
      }

      const runId = store.newId();
      await store.insertRun({
        runId,
        bodyId,
        bodyVersion,
        scope: input.scope,
        modelRegistryId: model.modelRegistryId,
        modelProviderLabel: model.providerLabel,
        modelKey: model.modelKey,
        modelDisplayName: model.displayName,
        inputMessage: input.inputMessage,
        addressedChannel: input.addressedChannel ?? null,
        startedAtIso: store.nowIso(),
      });
      return executeAgentInstanceRun(
        { store, clock: deps.clock, ids: deps.ids, aiRuntime: deps.aiRuntime },
        {
          runId,
          scope: input.scope,
          body: { bodyId, bodyVersion, contract: body.contract },
          model: {
            modelRegistryId: model.modelRegistryId,
            providerLabel: model.providerLabel,
            modelKey: model.modelKey,
            displayName: model.displayName,
            status: model.status,
            availabilityState: model.availabilityState,
          },
          inputMessage: input.inputMessage,
          addressedChannel: input.addressedChannel ?? null,
        },
        input.backend,
        input.toolExecutor,
      );
    },

    async getRun(scope, runId) {
      assertScope(scope);
      assertUuidShape('lab agent instance run', runId);
      const row = await store.findRun(scope.clientId, runId);
      if (row === null) {
        throw new NotFoundError('lab agent instance run', runId);
      }
      return mapRunRow(row);
    },

    async listRuns(scope, bodyId) {
      assertScope(scope);
      if (bodyId !== undefined) assertUuidShape('lab agent body', bodyId);
      const rows = await store.listRuns(scope.clientId, bodyId);
      return rows.map(mapRunRow);
    },

    async listRunEvents(scope, runId): Promise<ReadonlyArray<LabAgentRunEventRecord>> {
      assertScope(scope);
      assertUuidShape('lab agent instance run', runId);
      const run = await store.findRun(scope.clientId, runId);
      if (run === null) {
        throw new NotFoundError('lab agent instance run', runId);
      }
      const rows = await store.listRunEvents(scope.clientId, runId);
      return rows.map(mapEventRow);
    },

    // --- Memory interfaces (bounded, scoped — the read surface) ---

    async readBodyMemory(scope, bodyId, memoryId): Promise<ReadonlyArray<LabAgentMemoryEntryRecord>> {
      assertScope(scope);
      assertUuidShape('lab agent body', bodyId);
      if (typeof memoryId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(memoryId)) {
        throw new InvalidRequestError('memoryId must be 1-64 chars of [a-z0-9-]');
      }
      const body = await requireLatestBody(scope, bodyId);
      const declared = body.contract.memoryInterfaces.some((memory) => memory.memoryId === memoryId);
      if (!declared) {
        throw new NotFoundError('lab agent body memory', `${bodyId}/${memoryId}`);
      }
      const rows = await store.listBodyMemoryEntries(scope.clientId, bodyId, memoryId);
      return rows.map(mapMemoryEntryRow);
    },
  };
}
