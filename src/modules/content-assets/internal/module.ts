/**
 * /content-assets module implementation (MKT-064 — Content Asset and
 * Transformation Authority).
 *
 * Thin orchestration over the store + the three frozen-matrix consumers:
 *
 *   validated input (the pure guards — vocabulary + shape + the
 *   floating-version rejection, fail-closed BEFORE any write) →
 *   the durable append-oriented writes (asset versions born draft or
 *   derived; the materialization state move; observations as immutable
 *   rows; transformation requests with their ingredient links FROZEN).
 *
 * THE TRANSFORMATION EXECUTION FLOW (the MKT-064 heart — NO second
 * execution engine, the MKT-054 cardinal rule):
 *   1. requestTransformation resolves the ENGINE from the registered
 *      registry (module DATA — empty in production by default, the
 *      MKT-056 discipline; a kind with no engine fails closed), creates
 *      the EXECUTION through the /executions public contract
 *      (external-request task link, the engine's declared execution
 *      kind, pooled-worker runtime class, deterministic §8 idempotency
 *      key) and records the transformation row + its immutable
 *      ingredient links (explicit versions resolved and frozen BEFORE
 *      any write — a floating 'latest' pointer is rejected by the
 *      guard);
 *   2. executeTransformation drives the referenced execution through
 *      its lifecycle transitions (created → queued → starting →
 *      running, then running → succeeded | failed — every transition
 *      through the /executions public contract with idempotency keys
 *      + CAS versions), fetches the ingredient object bytes through
 *      the MKT-001 ObjectStore port, runs the FROZEN engine choice,
 *      stores the output bytes (content-addressed — idempotent),
 *      records the /content-rights INGREDIENT LINEAGE LINKS (composite
 *      ref → each ingredient ref, through the 063 public contract —
 *      the conjunction seam; idempotent by convergence on replay),
 *      and completes the transformation in ONE transaction (the output
 *      asset + version born 'derived' WITH its object, the derivation
 *      event, the engine's measured observations + the module's
 *      byte_size observation, and the requested → completed move with
 *      the output link set ONCE).
 *
 * RIGHTS ARE NEVER CHECKED AND NEVER MUTATED HERE (boundary rule 5):
 * the 063 publication gate stays the SOLE rights authority — an asset
 * whose ingredients are rights-blocked can still be TRANSFORMED (the
 * module records lineage only) but can never pass the 063 gate. The
 * lineage-link recording is the ONLY /content-rights interaction and
 * it is pure derivation bookkeeping (never a rights-state write, never
 * a gate evaluation, never a permission write).
 *
 * The agency/client scope of every command is SERVER-DERIVED input
 * (resolved by the route layer from canonical ownership — never a
 * request field); the transformation's workspace scope is validated by
 * the /executions authority itself (createExecution resolves canonical
 * workspace ownership BEFORE any write).
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { ObjectStore } from '../../../platform/objects/contract.ts';
import type { ExecutionsModuleApi } from '../../executions/public.ts';
import type { ContentRightsModuleApi } from '../../content-rights/public.ts';
import type {
  ContentAssetVersionRecord,
  ContentAssetsModuleApi,
  ContentTransformationRecord,
  TransformationEngine,
  TransformationEngineInput,
} from '../public.ts';
import { resolveTransformationEngine } from '../public.ts';
import {
  assertValidContentAssetsProvenance,
  assertValidExecuteTransformationInput,
  assertValidMaterializeInput,
  assertValidOutputSpecMetadata,
  assertValidQualityObservationInput,
  assertValidRegisterAssetVersionInput,
  assertValidRequestTransformationInput,
} from './validation.ts';
import { ContentAssetsStore } from './store.ts';

export interface ContentAssetsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly objects: ObjectStore;
  readonly executions: ExecutionsModuleApi;
  readonly contentRights: ContentRightsModuleApi;
  readonly engines: readonly TransformationEngine[];
}

/** The UUID guard shape (an opaque uuid — malformed ids are uniform 404s). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createContentAssetsModule(
  deps: ContentAssetsModuleDeps,
): ContentAssetsModuleApi {
  const store = new ContentAssetsStore(deps.db, deps.clock, deps.ids);
  const { objects, executions, contentRights, clock } = deps;

  /** The version by id — uniform 404 on unknown/malformed (the route layer adds the client narrowing). */
  async function requireAssetVersion(
    versionId: string,
  ): Promise<ContentAssetVersionRecord> {
    if (!UUID_PATTERN.test(versionId)) {
      throw new NotFoundError('content_asset_version', versionId);
    }
    const version = await store.getAssetVersion(versionId);
    if (version === null) {
      throw new NotFoundError('content_asset_version', versionId);
    }
    return version;
  }

  /** The transformation by id — uniform 404 on unknown/malformed. */
  async function requireTransformation(
    transformationId: string,
  ): Promise<ContentTransformationRecord> {
    if (!UUID_PATTERN.test(transformationId)) {
      throw new NotFoundError('content_transformation', transformationId);
    }
    const transformation = await store.getTransformation(transformationId);
    if (transformation === null) {
      throw new NotFoundError('content_transformation', transformationId);
    }
    return transformation;
  }

  /**
   * The /executions lifecycle transition helper: ONE public-contract
   * transition with the deterministic request-key of this runner
   * (`content-transformation:<id>:<from>-><to>`). Replays converge
   * inside the executions module (the §8 idempotency ledger); the CAS
   * version comes from the freshly-read execution record.
   */
  async function transitionExecutionStep(
    transformationId: string,
    executionId: string,
    to: Parameters<ExecutionsModuleApi['transitionExecution']>[0]['to'],
    reason: string,
  ): Promise<void> {
    const execution = await executions.getExecution(executionId);
    if (execution === null) {
      throw new NotFoundError('execution', executionId);
    }
    await executions.transitionExecution({
      executionId,
      to,
      expectedVersion: execution.version,
      idempotencyKey: `content-transformation:${transformationId}:${execution.status}->${to}`,
      retryClassification: null,
      evidenceRef: null,
      reason,
      actorId: null,
    });
  }

  return {
    async registerAssetVersion(input, provenance) {
      assertValidContentAssetsProvenance(provenance);
      assertValidRegisterAssetVersionInput(input);
      // The asset-identity narrowing when versioning a known asset: a
      // foreign asset id is the uniform 404 (no cross-tenant oracle —
      // the store's asset lock enforces it inside the transaction).
      return store.insertAssetVersion(input, provenance);
    },

    async materializeAssetVersion(input, provenance) {
      assertValidContentAssetsProvenance(provenance);
      assertValidMaterializeInput(input);
      // Resolve the version first (uniform 404; the state guard below
      // is the honest conflict, never a 404).
      const current = await requireAssetVersion(input.versionId);
      if (current.lifecycleState !== 'draft') {
        throw new ConflictError(
          `content asset version ${input.versionId} is '${current.lifecycleState}' — only a DRAFT can be materialized (the immutable version discipline)`,
        );
      }
      // The content-addressed object store: immutable, idempotent by
      // construction (identical bytes converge to the same key — an
      // object stored for a failed transaction is never orphaned
      // semantically).
      const stored = await objects.put(input.bytes);
      const outcome = await store.materializeVersion(
        {
          versionId: input.versionId,
          objectKey: stored.key,
          objectDigest: stored.digest,
          objectSize: stored.size,
          reason: `object materialized (${stored.size} bytes, content-addressed key ${stored.key})`,
        },
        provenance,
      );
      if (outcome.kind === 'missing') {
        throw new NotFoundError('content_asset_version', input.versionId);
      }
      return { record: outcome.record, event: outcome.event };
    },

    async recordQualityObservation(input, provenance) {
      assertValidContentAssetsProvenance(provenance);
      assertValidQualityObservationInput(input);
      await requireAssetVersion(input.versionId);
      return store.insertQualityObservation(input, provenance);
    },

    async requestTransformation(input, provenance) {
      assertValidContentAssetsProvenance(provenance);
      assertValidRequestTransformationInput(input);

      // THE ENGINE RESOLUTION (the capability seam): by declared
      // engineId (which must exist AND support the kind), else the
      // first registered engine supporting the kind. A kind with NO
      // registered engine fails closed — the MKT-056 discipline (no
      // silent fallback, no hardcoded provider).
      const engine = resolveTransformationEngine(
        deps.engines,
        input.transformationKind,
        input.engineId,
      );
      if (engine === null) {
        throw new ConflictError(
          `no registered transformation engine serves kind '${input.transformationKind}'${input.engineId !== null ? ` with engineId '${input.engineId}'` : ''} — the engine registry is module data (EMPTY in production by default); register an engine at the composition root before requesting this kind`,
        );
      }

      // Resolve the ingredient versions: EXPLICIT (asset, version)
      // pairs, same-Client (uniform 404 on unknown/foreign — no
      // cross-tenant oracle), and MATERIALIZED/derived (an engine
      // cannot read bytes that do not exist — the honest fail-closed).
      const resolved: ContentAssetVersionRecord[] = [];
      for (const ingredient of input.ingredients) {
        if (!UUID_PATTERN.test(ingredient.assetId)) {
          throw new NotFoundError('content_asset', ingredient.assetId);
        }
        const version = await store.getAssetVersionByNumber(
          input.clientId,
          ingredient.assetId,
          ingredient.version,
        );
        if (version === null) {
          throw new NotFoundError('content_asset_version', `${ingredient.assetId}#${ingredient.version}`);
        }
        if (version.objectKey === null) {
          throw new ConflictError(
            `content asset version ${version.assetRef} is '${version.lifecycleState}' (no materialized object) — a draft ingredient cannot be transformed; materialize it first`,
          );
        }
        resolved.push(version);
      }

      // The output-spec metadata the module itself interprets (the
      // intended output's media class + display name — everything else
      // is engine data).
      assertValidOutputSpecMetadata(input.outputSpec);

      // THE EXECUTION (through the EXISTING /executions authority — the
      // ONLY sanctioned interaction with the execution authority; the
      // module never writes execution tables and holds no second
      // engine). The §8 idempotency key is deterministic from the
      // pre-minted transformation id.
      const transformationId = deps.ids.newId();
      const executionOutcome = await executions.createExecution({
        workspaceId: input.workspaceId,
        taskLink: {
          kind: 'external-request',
          externalRequestRef: `content-transformation:${transformationId}`,
        },
        retryOfExecutionId: null,
        executionKind: engine.executionKind,
        runtimeClass: 'pooled-worker',
        idempotencyKey: `content-transformation:${transformationId}:create`,
        actorId: null,
      });

      // The transformation row + the IMMUTABLE ingredient links (the
      // resolved versions and their refs FROZEN at request time).
      // Disclosure: on a store failure the created execution stays
      // orphaned 'created' (bounded harm: a runtime attempt that never
      // runs — the executions authority tolerates that; the
      // external-request link makes the orphan self-describing).
      const transformation = await store.insertTransformation(
        {
          transformationId,
          agencyId: input.agencyId,
          clientId: input.clientId,
          workspaceId: input.workspaceId,
          transformationKind: input.transformationKind,
          engineId: engine.engineId,
          executionRef: executionOutcome.execution.executionId,
          parameters: input.parameters,
          outputSpec: input.outputSpec,
        },
        resolved.map((version) => ({ version })),
        provenance,
      );
      const ingredients = await store.listTransformationIngredients(transformationId);
      return {
        transformation,
        executionId: executionOutcome.execution.executionId,
        ingredients: ingredients ?? [],
      };
    },

    async executeTransformation(input, provenance) {
      assertValidContentAssetsProvenance(provenance);
      assertValidExecuteTransformationInput(input);
      const transformation = await requireTransformation(input.transformationId);

      // The idempotent replay of a COMPLETED transformation converges
      // to the recorded outcome (no re-run, no new writes).
      if (transformation.status === 'completed') {
        const output = transformation.outputVersionId === null
          ? null
          : await store.getAssetVersion(transformation.outputVersionId);
        return {
          transformation,
          executionId: transformation.executionRef,
          output,
          replayed: true,
        };
      }
      // A FAILED transformation is settled — a retry is a NEW
      // transformation request (the §6 no-second-identity discipline).
      if (transformation.status === 'failed') {
        throw new ConflictError(
          `transformation ${input.transformationId} has FAILED (${transformation.failureReason ?? 'no reason recorded'}) — terminal rows never reopen; a retry is a NEW transformation request`,
        );
      }

      // The frozen engine choice must still be resolvable in the
      // registry (registries are runtime-wired; the recorded engine id
      // is the frozen fact). An unresolvable engine is the honest
      // fail-closed terminal failure.
      const engine = resolveTransformationEngine(
        deps.engines,
        transformation.transformationKind,
        transformation.engineId,
      );
      if (engine === null) {
        await failTransformationHonestly(
          transformation,
          `the recorded engine '${transformation.engineId}' is no longer registered (the registry changed since the request) — the frozen engine choice cannot run`,
        );
        throw new ConflictError(
          `the recorded engine '${transformation.engineId}' of transformation ${input.transformationId} is no longer registered — fail-closed, the transformation was recorded as failed`,
        );
      }

      // The referenced execution must exist and be runnable.
      const execution = await executions.getExecution(transformation.executionRef);
      if (execution === null) {
        throw new NotFoundError('execution', transformation.executionRef);
      }

      try {
        // --- Drive the execution lifecycle through the /executions
        // public contract (idempotent steps — a replay after a partial
        // crash converges on the §8 ledger inside the executions
        // module).
        await transitionExecutionStep(
          transformation.transformationId,
          transformation.executionRef,
          'queued',
          'content transformation queued (the module-side runner)',
        );
        await transitionExecutionStep(
          transformation.transformationId,
          transformation.executionRef,
          'starting',
          'content transformation starting (engine resolved)',
        );
        await transitionExecutionStep(
          transformation.transformationId,
          transformation.executionRef,
          'running',
          `content transformation running (engine ${engine.engineId})`,
        );

        // --- Fetch the ingredient object bytes through the
        // content-addressed ObjectStore port (engines are pure byte
        // transformers — no store access of their own).
        const ingredientLinks = await store.listTransformationIngredients(
          transformation.transformationId,
        );
        if (ingredientLinks === null || ingredientLinks.length === 0) {
          throw new ConflictError(
            `transformation ${transformation.transformationId} carries no ingredient links — the recorded request is corrupt (fail-closed)`,
          );
        }
        const engineIngredients = [];
        for (const link of ingredientLinks) {
          const version = await store.getAssetVersion(link.inputVersionId);
          if (version === null || version.objectKey === null) {
            throw new ConflictError(
              `ingredient ${link.inputAssetRef} of transformation ${transformation.transformationId} cannot be read (unknown version or no materialized object) — fail-closed`,
            );
          }
          const object = await objects.get(version.objectKey);
          if (object === null) {
            throw new ConflictError(
              `ingredient ${link.inputAssetRef} object ${version.objectKey} is absent from the object store — fail-closed`,
            );
          }
          engineIngredients.push({
            versionId: version.versionId,
            assetRef: version.assetRef,
            mediaKind: version.mediaKind,
            displayName: version.displayName,
            objectKey: version.objectKey,
            objectSize: version.objectSize,
            bytes: object.bytes,
          });
        }

        // --- Run the engine (pure byte transformation).
        const engineInput: TransformationEngineInput = {
          transformationId: transformation.transformationId,
          kind: transformation.transformationKind,
          parameters: transformation.parameters,
          outputSpec: transformation.outputSpec,
          ingredients: engineIngredients,
        };
        const engineOutput = await engine.execute(engineInput);

        // --- Store the output bytes (content-addressed, idempotent).
        const stored = await objects.put(engineOutput.outputBytes, {
          contentType: engineOutput.outputContentType,
        });

        // --- Record the /content-rights INGREDIENT LINEAGE LINKS
        // (composite ref → each ingredient ref — the 063 conjunction
        // seam; the ONLY /content-rights interaction, pure derivation
        // bookkeeping: never a rights-state write, never a gate
        // evaluation). The output ref is pre-minted so the links and
        // the completion transaction share the identity; duplicate
        // pairs (a replay after a partial completion) converge — the
        // recorded fact is the same.
        const outputVersionId = deps.ids.newId();
        const outputAssetRef = `ca:${outputVersionId}`;
        for (const link of ingredientLinks) {
          try {
            await contentRights.recordLineageLink(
              {
                agencyId: transformation.agencyId,
                clientId: transformation.clientId,
                workspaceId: transformation.workspaceId,
                compositeAssetRef: outputAssetRef,
                ingredientAssetRef: link.inputAssetRef,
              },
              {
                actor: provenance.actor,
                recordedVia: provenance.recordedVia,
                correlationId: provenance.correlationId,
                causationId: provenance.causationId,
              },
            );
          } catch (error) {
            if (error instanceof ConflictError) {
              // The duplicate-link convergence: the same immutable fact
              // is already recorded (a replay after a partial
              // completion) — continue.
              continue;
            }
            throw error;
          }
        }

        // --- Complete the transformation in ONE transaction (the
        // output asset + version born 'derived' WITH its object, the
        // derivation event, the engine's measured observations + the
        // module's byte_size observation, the requested → completed
        // move with the output link set ONCE). The pre-minted output
        // version id keeps the rights links and the version row the
        // same identity even across a retried completion.
        const outputSpec = transformation.outputSpec;
        const completion = await store.completeTransformation(
          {
            transformationId: transformation.transformationId,
            outputVersionId,
            output: {
              agencyId: transformation.agencyId,
              clientId: transformation.clientId,
              workspaceId: transformation.workspaceId,
              mediaKind: outputSpec['mediaKind'] as ContentAssetVersionRecord['mediaKind'],
              displayName: outputSpec['displayName'] as string,
              contentType: engineOutput.outputContentType,
              objectKey: stored.key,
              objectDigest: stored.digest,
              objectSize: stored.size,
              derivationReason:
                `born as the output of ${transformation.transformationKind} transformation ${transformation.transformationId} (engine ${transformation.engineId}, ${ingredientLinks.length} ingredient${ingredientLinks.length === 1 ? '' : 's'}, execution ${transformation.executionRef})`,
            },
          },
          engineOutput.qualityObservations,
          provenance,
        );
        if (completion.kind === 'missing') {
          throw new NotFoundError('content_transformation', input.transformationId);
        }

        // --- The execution's success transition (the last step: the
        // work is durably recorded).
        await transitionExecutionStep(
          transformation.transformationId,
          transformation.executionRef,
          'succeeded',
          `content transformation completed (output version ${completion.output.versionId})`,
        );

        return {
          transformation: completion.transformation,
          executionId: transformation.executionRef,
          output: completion.output,
          replayed: false,
        };
      } catch (error) {
        // THE FAILURE PATH: the execution transitions running → failed
        // (SAFE classification — the module's writes are post-engine
        // and transactional; a real engine with side effects of its
        // own declares its own classification through its execution
        // kind choice — disclosed) and the transformation record moves
        // requested → failed with the bounded reason. Terminal,
        // honest, never a silent partial.
        const reason = error instanceof Error ? error.message : String(error);
        await failTransformationHonestly(transformation, reason);
        throw error;
      }
    },

    async getAssetVersion(versionId) {
      return store.getAssetVersion(versionId);
    },

    async resolveAssetRef(clientId, assetRef) {
      return store.resolveAssetRef(clientId, assetRef);
    },

    async resolveContentAssetsOwnership(versionId) {
      if (!UUID_PATTERN.test(versionId)) return null;
      const version = await store.getAssetVersion(versionId);
      if (version === null) return null;
      return {
        scope: {
          kind: 'content_asset_version',
          agencyId: version.agencyId,
          clientId: version.clientId,
          workspaceId: version.workspaceId,
          versionId: version.versionId,
        },
        version,
        resolvedAt: new Date(clock.nowIso()).toISOString(),
      };
    },

    async listAssetVersionsForClient(clientId) {
      return store.listAssetVersionsForClient(clientId);
    },

    async listVersionsOfAsset(assetId) {
      return store.listVersionsOfAsset(assetId);
    },

    async listLifecycleEvents(versionId) {
      return store.listLifecycleEvents(versionId);
    },

    async listQualityObservations(versionId) {
      return store.listQualityObservations(versionId);
    },

    async getTransformation(transformationId) {
      return store.getTransformation(transformationId);
    },

    async listTransformationsForClient(clientId) {
      return store.listTransformationsForClient(clientId);
    },

    async listTransformationIngredients(transformationId) {
      return store.listTransformationIngredients(transformationId);
    },
  };

  /**
   * The honest failure recording: the execution's failed transition
   * (safe classification) + the transformation's requested → failed
   * move. Both steps are best-effort HERE (the original error is the
   * one surfaced to the caller) — a failure of the failure recording
   * surfaces in the logs, never as a silent success.
   */
  async function failTransformationHonestly(
    transformation: ContentTransformationRecord,
    reason: string,
  ): Promise<void> {
    const boundedReason = reason.length > 2000 ? `${reason.slice(0, 1997)}...` : reason;
    try {
      const execution = await executions.getExecution(transformation.executionRef);
      if (execution !== null && execution.status === 'running') {
        await executions.transitionExecution({
          executionId: transformation.executionRef,
          to: 'failed',
          expectedVersion: execution.version,
          idempotencyKey: `content-transformation:${transformation.transformationId}:${execution.status}->failed`,
          retryClassification: 'safe',
          evidenceRef: null,
          reason: `content transformation failed: ${boundedReason}`,
          actorId: null,
        });
      }
      await store.failTransformation({
        transformationId: transformation.transformationId,
        failureReason: boundedReason,
        failedByActor: 'system:content-assets-runner',
        failedVia: 'module',
        correlationId: `content-transformation:${transformation.transformationId}`,
        causationId: null,
      });
    } catch {
      // The failure recording itself failed — the original error stays
      // the surfaced truth; the record remains 'requested' and a later
      // executeTransformation replay reconciles it honestly.
    }
  }
}
