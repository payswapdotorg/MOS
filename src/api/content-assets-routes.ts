/**
 * /api/clients/:clientId/content-assets/* routes (MKT-064 — the Content
 * Asset and Transformation Authority surface: the versioned asset
 * records + the quality observations + the transformation family).
 *
 *   POST  /api/clients/:clientId/content-assets                                         register an asset version (owner|admin) — born draft (or a new logical asset)
 *   GET   /api/clients/:clientId/content-assets                                         the client's asset versions (any active member)
 *   GET   /api/clients/:clientId/content-assets/by-ref/:assetRef                       resolve ONE version by its opaque ref (any active member)
 *   POST  /api/clients/:clientId/content-assets/transformations                         request a transformation (owner|admin) — kind + explicit ingredient versions + parameters + output spec
 *   GET   /api/clients/:clientId/content-assets/transformations                         the client's transformations (any active member)
 *   GET   /api/clients/:clientId/content-assets/transformations/:transformationId       one transformation + its immutable ingredient tail (any active member)
 *   POST  /api/clients/:clientId/content-assets/transformations/:transformationId/execute  execute one requested transformation (owner|admin) — the runner through the /executions authority
 *   GET   /api/clients/:clientId/content-assets/:versionId                              one version + its full append-only tails (any active member)
 *   POST  /api/clients/:clientId/content-assets/:versionId/materialize                 THE MATERIALIZATION MOVE (owner|admin) — store the object bytes, draft → materialized
 *   POST  /api/clients/:clientId/content-assets/:versionId/observations                 append ONE quality observation (owner|admin)
 *
 * Literal-segment routes (by-ref, transformations) are registered BEFORE
 * the :versionId patterns: the literal segments sit in the :versionId
 * position and the router resolves first-match-wins (the jobs-queue /
 * content-rights precedent).
 *
 * There is deliberately NO update route (version records are immutable —
 * a correction is a NEW version, which is a NEW reference), NO delete
 * route (asset/event/observation/ingredient history is append-only —
 * the migration-053 triggers reject it at the database) and NO
 * rights-mutating route of ANY kind (boundary rule 5: transforming an
 * asset never checks or mutates rights — the /content-rights surfaces
 * own the rights records and the publication gate; the derivation-side
 * lineage links are recorded by the MODULE during execution, never
 * through a route).
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: the DTOs reject
 * identity/ownership/lifecycle/outcome/provenance fields AND every
 * material-shaped key (§21 — the strict-validation precedent; object
 * bytes arrive as a bounded base64 payload only). The tenant scope
 * chain is server-derived from the canonical /clients ownership
 * resolution; the /evidence-anchored source provenance is resolved
 * canonically at THIS layer before any write (uniform 404 for
 * unknown/foreign evidence — the /app-metering precedent, because
 * /evidence is not a frozen allowance of the /content-assets row; the
 * migration-053 same-Client triggers are the DB backstop).
 *
 * Authorization follows the established hard-boundary posture: every
 * route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /clients chain; the version- and
 * transformation-scoped routes additionally resolve canonical content
 * ownership and yield a UNIFORM 404 for unknown/foreign/mismatched
 * identifiers — no cross-tenant oracle), and authorizes against the
 * SAME /agencies membership authority as every other scoped check.
 */

import { NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  arrayField,
  intField,
  objectField,
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireClientAccess, requireWorkspaceAccess } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  ContentAssetLifecycleEventRecord,
  ContentAssetVersionRecord,
  ContentAssetsProvenance,
  ContentQualityObservationRecord,
  ContentTransformationIngredientRecord,
  ContentTransformationRecord,
} from '../modules/content-assets/public.ts';
import {
  CONTENT_ASSETS_VOCABULARY_VERSION,
} from '../modules/content-assets/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_KIND_PATTERN = /^(video|audio|image|text|document)$/;
const TRANSFORMATION_KIND_PATTERN =
  /^(crop|reframe|padding|compilation|clip|caption|voice|translation|format)$/;
const METRIC_PATTERN =
  /^(duration_ms|width_px|height_px|bitrate_kbps|caption_coverage_ratio|language|fps|sample_rate_hz|byte_size)$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_BASE64_LENGTH = Math.ceil((8 * 1024 * 1024) / 3) * 4 + 8;

/**
 * Fields always server-derived on the content-assets surfaces — plus
 * every material-shaped key is rejected (§21: nothing secret can even
 * be smuggled into an asset record; evidence arrives as /evidence
 * REFERENCES resolved through the evidence authority, never as inline
 * payloads; object bytes arrive as a bounded base64 payload only).
 */
const CONTENT_ASSETS_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/lifecycle/outcome — NEVER request
  // fields. (The CALLER-supplied inputs — assetId, version, workspaceId,
  // ingredients, engineId, sourceEvidenceRef — are deliberately absent:
  // they are the honest request vocabulary of this surface; the module
  // guards own their semantics.)
  'versionId',
  'assetRef',
  'eventId',
  'observationId',
  'transformationId',
  'ingredientId',
  'agencyId',
  'clientId',
  'versionCas',
  'lifecycleState',
  'objectKey',
  'objectDigest',
  'objectSize',
  'status',
  'executionRef',
  'executionId',
  'outputVersionId',
  'completedAt',
  'failureReason',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'observedAt',
  'createdAt',
  'updatedAt',
  'replayed',
  'output',
];

/** The nested ingredient DTO's forbidden set (the caller names exactly
 *  assetId + version — everything else is server-derived). */
const INGREDIENT_AUTHORITY_FIELDS = [
  'versionId',
  'ingredientId',
  'assetRef',
  'inputAssetRef',
  'position',
  'inputVersionId',
  'inputVersionNumber',
  'provenance',
  'created_at',
];

function serverProvenance(principal: Principal): ContentAssetsProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Serialization (presentation only; every field of the record ships)
// ---------------------------------------------------------------------------

function serializeProvenance(
  provenance: ContentAssetsProvenance & { readonly recordedAt?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
  };
  if (provenance.causationId !== null && provenance.causationId !== undefined) {
    out['causationId'] = provenance.causationId;
  }
  if (provenance.recordedAt !== undefined) {
    out['recordedAt'] = provenance.recordedAt;
  }
  return out;
}

function serializeVersion(record: ContentAssetVersionRecord): Record<string, unknown> {
  return {
    versionId: record.versionId,
    assetId: record.assetId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    version: record.version,
    assetRef: record.assetRef,
    mediaKind: record.mediaKind,
    displayName: record.displayName,
    contentType: record.contentType,
    lifecycleState: record.lifecycleState,
    ...(record.objectKey === null ? {} : {
      objectKey: record.objectKey,
      objectDigest: record.objectDigest,
      objectSize: record.objectSize,
    }),
    sourceEvidenceRef: record.sourceEvidenceRef,
    provenance: serializeProvenance(record.provenance),
    versionCas: record.versionCas,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeLifecycleEvent(
  event: ContentAssetLifecycleEventRecord,
): Record<string, unknown> {
  return {
    eventId: event.eventId,
    versionId: event.versionId,
    eventKind: event.eventKind,
    ...(event.fromState === null ? {} : { fromState: event.fromState }),
    toState: event.toState,
    reason: event.reason,
    provenance: serializeProvenance(event.provenance),
  };
}

function serializeObservation(
  observation: ContentQualityObservationRecord,
): Record<string, unknown> {
  return {
    observationId: observation.observationId,
    versionId: observation.versionId,
    metric: observation.metric,
    ...(observation.metricValueNumeric === null
      ? {}
      : { metricValueNumeric: observation.metricValueNumeric }),
    ...(observation.metricValueText === null ? {} : { metricValueText: observation.metricValueText }),
    observedAt: observation.observedAt,
    provenance: serializeProvenance(observation.provenance),
  };
}

function serializeTransformation(
  transformation: ContentTransformationRecord,
): Record<string, unknown> {
  return {
    transformationId: transformation.transformationId,
    agencyId: transformation.agencyId,
    clientId: transformation.clientId,
    workspaceId: transformation.workspaceId,
    transformationKind: transformation.transformationKind,
    engineId: transformation.engineId,
    status: transformation.status,
    executionRef: transformation.executionRef,
    parameters: transformation.parameters,
    outputSpec: transformation.outputSpec,
    ...(transformation.outputVersionId === null
      ? {}
      : { outputVersionId: transformation.outputVersionId }),
    ...(transformation.completedAt === null ? {} : { completedAt: transformation.completedAt }),
    ...(transformation.failureReason === null ? {} : { failureReason: transformation.failureReason }),
    provenance: serializeProvenance(transformation.provenance),
    versionCas: transformation.versionCas,
    createdAt: transformation.createdAt,
    updatedAt: transformation.updatedAt,
  };
}

function serializeIngredient(
  ingredient: ContentTransformationIngredientRecord,
): Record<string, unknown> {
  return {
    ingredientId: ingredient.ingredientId,
    transformationId: ingredient.transformationId,
    inputVersionId: ingredient.inputVersionId,
    inputAssetRef: ingredient.inputAssetRef,
    inputVersionNumber: ingredient.inputVersionNumber,
    position: ingredient.position,
    provenance: serializeProvenance(ingredient.provenance),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** The validated register DTO (the strict-validation output type). */
type ValidatedRegisterBody = {
  readonly mediaKind: string;
  readonly displayName: string;
  readonly contentType: string;
  readonly sourceEvidenceRef: string;
  readonly assetId: string | undefined;
  readonly workspaceId: string | undefined;
};

/** The validated materialize DTO. */
type ValidatedMaterializeBody = {
  readonly bytesBase64: string;
};

/** The validated observation DTO (the numeric value rides as a bounded numeric string — the strict string-field transport). */
type ValidatedObservationBody = {
  readonly metric: string;
  readonly numericValue: string | undefined;
  readonly textValue: string | undefined;
};

/** The validated transformation-request DTO. */
type ValidatedTransformationBody = {
  readonly transformationKind: string;
  readonly parameters: Record<string, unknown>;
  readonly outputSpec: Record<string, unknown>;
  readonly ingredients: { readonly assetId: string; readonly version: number }[];
  readonly engineId: string | undefined;
  readonly workspaceId: string;
};

export function registerContentAssetsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('content-assets.api');

  /** Canonical client owner scope; 404 BEFORE dependent traversal. */
  async function clientOwner(clientId: string): Promise<OwnerScope> {
    const ownership = await modules.clients.resolveClientOwnership(clientId);
    if (ownership === null) {
      throw new NotFoundError('client', clientId);
    }
    return {
      kind: 'client',
      agencyId: ownership.client.agencyId,
      clientId: ownership.client.clientId,
    };
  }

  /**
   * The canonical /evidence resolution at the ROUTE layer (the
   * /app-metering precedent — /evidence is not a frozen allowance of
   * the /content-assets matrix row, so the id-based anchor resolves
   * canonically HERE): the record must exist AND belong to the SAME
   * Client — unknown and foreign are the SAME uniform NotFoundError
   * (no cross-tenant oracle; the migration-053 same-Client triggers
   * are the DB backstop).
   */
  async function requireEvidenceInClient(
    clientId: string,
    evidenceRef: string,
  ): Promise<void> {
    if (!UUID_PATTERN.test(evidenceRef)) {
      throw new NotFoundError('evidence', evidenceRef);
    }
    const evidence = await modules.evidence.getEvidence(evidenceRef);
    if (evidence === null || evidence.clientId !== clientId) {
      throw new NotFoundError('evidence', evidenceRef);
    }
  }

  /**
   * The canonical version ownership resolution for every version-scoped
   * route: the module resolves the version + its owning chain; a
   * version that does not exist, or that belongs to ANOTHER Client than
   * the path's, is the SAME uniform 404 (a foreign identifier is not a
   * traversal oracle). Malformed ids are the same uniform 404 (the
   * module's UUID guard).
   */
  async function requireVersionInClient(versionId: string, clientId: string) {
    if (!UUID_PATTERN.test(versionId)) {
      throw new NotFoundError('content_asset_version', versionId);
    }
    const ownership = await modules.contentAssets.resolveContentAssetsOwnership(versionId);
    if (ownership === null || ownership.version.clientId !== clientId) {
      throw new NotFoundError('content_asset_version', versionId);
    }
    return ownership;
  }

  /**
   * The canonical transformation ownership resolution (same uniform-404
   * posture). The transformation's client must equal the path's.
   */
  async function requireTransformationInClient(
    transformationId: string,
    clientId: string,
  ): Promise<ContentTransformationRecord> {
    if (!UUID_PATTERN.test(transformationId)) {
      throw new NotFoundError('content_transformation', transformationId);
    }
    const transformation = await modules.contentAssets.getTransformation(transformationId);
    if (transformation === null || transformation.clientId !== clientId) {
      throw new NotFoundError('content_transformation', transformationId);
    }
    return transformation;
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-assets — register an asset
  // version (born draft; source provenance REQUIRED; a known asset id
  // creates the NEXT explicit version — the correction discipline).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-assets',
    defineMutationRoute<{ clientId: string }, ContentAssetVersionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedRegisterBody>(ctx.request.body, {
          forbiddenKeys: CONTENT_ASSETS_AUTHORITY_FIELDS,
          fields: {
            mediaKind: stringField({ pattern: MEDIA_KIND_PATTERN }),
            displayName: stringField({ minLength: 1, maxLength: 200 }),
            contentType: stringField({ minLength: 3, maxLength: 100 }),
            sourceEvidenceRef: stringField({ pattern: UUID_PATTERN }),
            assetId: optionalString({ pattern: UUID_PATTERN }),
            // The OPTIONAL workspace narrowing — validated against the
            // client's workspaces by the module's DB tenant fence, but
            // resolved canonically here first (uniform 404 on foreign).
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedRegisterBody;
        // The server-derived tenant scope (the /clients chain — never a
        // request field; the path only SELECTS which durable client
        // gets resolved).
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        if (body.workspaceId !== undefined) {
          await requireWorkspaceAccess(modules, ctx.principal, body.workspaceId);
        }
        // Canonical /evidence resolution BEFORE any write (the route-layer
        // id-seam precedent — uniform 404 for unknown/foreign).
        await requireEvidenceInClient(ctx.params.clientId, body.sourceEvidenceRef);
        return modules.contentAssets.registerAssetVersion(
          {
            agencyId: ownership.client.agencyId,
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            assetId: body.assetId ?? null,
            mediaKind: body.mediaKind as 'video' | 'audio' | 'image' | 'text' | 'document',
            displayName: body.displayName,
            contentType: body.contentType,
            sourceEvidenceRef: body.sourceEvidenceRef,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_assets.version_registered', undefined, {
          version_id: ctx.result.versionId,
          client_id: ctx.params.clientId,
          asset_ref: ctx.result.assetRef,
          media_kind: ctx.result.mediaKind,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_assets.version_registered',
          targetType: 'content_asset_version',
          targetId: ctx.result.versionId,
          afterVersion: ctx.result.versionCas,
          idempotencyKey: `content_assets.version_registered:${ctx.result.versionId}`,
          details: {
            assetRef: ctx.result.assetRef,
            mediaKind: ctx.result.mediaKind,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          version: serializeVersion(ctx.result),
          vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-assets — the client's asset
  // versions, newest first (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-assets',
    defineQueryRoute<{ clientId: string }, readonly ContentAssetVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.contentAssets.listAssetVersionsForClient(ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          versions: ctx.result.map(serializeVersion),
          vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-assets/by-ref/:assetRef — resolve
  // ONE version by its opaque content-asset ref (any active member; 404
  // when none exists — the seam resolution the ContentAssetReferencePort
  // exposes). Registered BEFORE the :versionId patterns
  // (first-match-wins).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-assets/by-ref/:assetRef',
    defineQueryRoute<{ clientId: string; assetRef: string }, ContentAssetVersionRecord | null>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.contentAssets.resolveAssetRef(ctx.params.clientId, ctx.params.assetRef),
      respond: (ctx) =>
        ctx.result === null
          ? jsonResponse(404, {
              error: 'NOT_FOUND',
              message: `no content asset version exists for ref '${ctx.params.assetRef}' in this client`,
            })
          : jsonResponse(200, {
              version: serializeVersion(ctx.result),
              vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
            }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-assets/transformations — request
  // a transformation (owner|admin): the kind + the EXPLICIT ingredient
  // versions + the per-kind parameters + the output spec. Registered
  // BEFORE the :versionId patterns (first-match-wins).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-assets/transformations',
    defineMutationRoute<
      { clientId: string },
      {
        transformation: ContentTransformationRecord;
        executionId: string;
        ingredients: readonly ContentTransformationIngredientRecord[];
      }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedTransformationBody>(ctx.request.body, {
          forbiddenKeys: CONTENT_ASSETS_AUTHORITY_FIELDS,
          fields: {
            transformationKind: stringField({ pattern: TRANSFORMATION_KIND_PATTERN }),
            parameters: recordField({ maxDepthKeys: 64 }),
            outputSpec: recordField({ maxDepthKeys: 64 }),
            ingredients: arrayField({
              minItems: 1,
              maxItems: 16,
              item: objectField({
                forbiddenKeys: INGREDIENT_AUTHORITY_FIELDS,
                fields: {
                  assetId: stringField({ pattern: UUID_PATTERN }),
                  // The EXPLICIT version — required, one-based: a
                  // floating 'latest' pointer cannot even be expressed
                  // (intField has no nullable form).
                  version: intField({ min: 1, max: 1_000_000 }),
                },
              }),
            }),
            engineId: optionalString({ minLength: 1, maxLength: 100 }),
            // The REQUIRED workspace scope of the execution (validated
            // canonically below — uniform 404 on foreign).
            workspaceId: stringField({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedTransformationBody;
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        // The execution authority is workspace-scoped: resolve the
        // workspace canonically (uniform 404 on unknown/foreign; the
        // /executions module re-validates ownership before any write).
        await requireWorkspaceAccess(modules, ctx.principal, body.workspaceId);
        return modules.contentAssets.requestTransformation(
          {
            agencyId: ownership.client.agencyId,
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId,
            transformationKind: body.transformationKind as
              | 'crop' | 'reframe' | 'padding' | 'compilation' | 'clip'
              | 'caption' | 'voice' | 'translation' | 'format',
            parameters: body.parameters,
            outputSpec: body.outputSpec,
            ingredients: body.ingredients,
            engineId: body.engineId ?? null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_assets.transformation_requested', undefined, {
          transformation_id: ctx.result.transformation.transformationId,
          client_id: ctx.params.clientId,
          kind: ctx.result.transformation.transformationKind,
          engine_id: ctx.result.transformation.engineId,
          execution_id: ctx.result.executionId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_assets.transformation_requested',
          targetType: 'content_transformation',
          targetId: ctx.result.transformation.transformationId,
          afterVersion: ctx.result.transformation.versionCas,
          idempotencyKey: `content_assets.transformation_requested:${ctx.result.transformation.transformationId}`,
          details: {
            kind: ctx.result.transformation.transformationKind,
            engineId: ctx.result.transformation.engineId,
            executionId: ctx.result.executionId,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          transformation: serializeTransformation(ctx.result.transformation),
          executionId: ctx.result.executionId,
          ingredients: ctx.result.ingredients.map(serializeIngredient),
          vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-assets/transformations — the
  // client's transformations, newest first (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-assets/transformations',
    defineQueryRoute<{ clientId: string }, readonly ContentTransformationRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.contentAssets.listTransformationsForClient(ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          transformations: ctx.result.map(serializeTransformation),
          vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-assets/transformations/:transformationId
  // — one transformation + its immutable ingredient tail (any active
  // member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-assets/transformations/:transformationId',
    defineQueryRoute<
      { clientId: string; transformationId: string },
      {
        transformation: ContentTransformationRecord;
        ingredients: readonly ContentTransformationIngredientRecord[];
        output: ContentAssetVersionRecord | null;
      }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        const transformation = await requireTransformationInClient(
          ctx.params.transformationId,
          ctx.params.clientId,
        );
        const ingredients =
          (await modules.contentAssets.listTransformationIngredients(
            ctx.params.transformationId,
          )) ?? [];
        const output = transformation.outputVersionId === null
          ? null
          : await modules.contentAssets.getAssetVersion(transformation.outputVersionId);
        return { transformation, ingredients, output };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          transformation: serializeTransformation(ctx.result.transformation),
          ingredients: ctx.result.ingredients.map(serializeIngredient),
          ...(ctx.result.output === null ? {} : { output: serializeVersion(ctx.result.output) }),
          vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-assets/transformations/:transformationId/execute
  // — execute ONE requested transformation (owner|admin): the module
  // runner drives the referenced execution through the /executions
  // authority, runs the frozen engine choice, stores the output and
  // creates the derived output version WITH its lineage.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-assets/transformations/:transformationId/execute',
    defineMutationRoute<
      { clientId: string; transformationId: string },
      {
        transformation: ContentTransformationRecord;
        executionId: string;
        output: ContentAssetVersionRecord | null;
        replayed: boolean;
      }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: CONTENT_ASSETS_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        await requireTransformationInClient(
          ctx.params.transformationId,
          ctx.params.clientId,
        );
        return modules.contentAssets.executeTransformation(
          { transformationId: ctx.params.transformationId },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_assets.transformation_executed', undefined, {
          transformation_id: ctx.result.transformation.transformationId,
          client_id: ctx.params.clientId,
          status: ctx.result.transformation.status,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_assets.transformation_executed',
          targetType: 'content_transformation',
          targetId: ctx.result.transformation.transformationId,
          afterVersion: ctx.result.transformation.versionCas,
          idempotencyKey: `content_assets.transformation_executed:${ctx.result.transformation.transformationId}:${ctx.result.transformation.versionCas}`,
          details: {
            status: ctx.result.transformation.status,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          transformation: serializeTransformation(ctx.result.transformation),
          executionId: ctx.result.executionId,
          ...(ctx.result.output === null ? {} : { output: serializeVersion(ctx.result.output) }),
          replayed: ctx.result.replayed,
          vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-assets/:versionId — one version +
  // its full append-only tails (lifecycle events, quality observations,
  // the transformations that consumed it as an ingredient — any active
  // member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-assets/:versionId',
    defineQueryRoute<
      { clientId: string; versionId: string },
      {
        version: ContentAssetVersionRecord;
        versionsOfAsset: readonly ContentAssetVersionRecord[];
        events: readonly ContentAssetLifecycleEventRecord[];
        observations: readonly ContentQualityObservationRecord[];
      }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        const ownership = await requireVersionInClient(ctx.params.versionId, ctx.params.clientId);
        const versionsOfAsset =
          (await modules.contentAssets.listVersionsOfAsset(ownership.version.assetId)) ?? [];
        const events =
          (await modules.contentAssets.listLifecycleEvents(ctx.params.versionId)) ?? [];
        const observations =
          (await modules.contentAssets.listQualityObservations(ctx.params.versionId)) ?? [];
        return { version: ownership.version, versionsOfAsset, events, observations };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          version: serializeVersion(ctx.result.version),
          versionsOfAsset: ctx.result.versionsOfAsset.map(serializeVersion),
          events: ctx.result.events.map(serializeLifecycleEvent),
          observations: ctx.result.observations.map(serializeObservation),
          vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-assets/:versionId/materialize —
  // THE MATERIALIZATION MOVE (owner|admin): store the object bytes
  // (bounded base64 payload), draft → materialized.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-assets/:versionId/materialize',
    defineMutationRoute<
      { clientId: string; versionId: string },
      {
        record: ContentAssetVersionRecord;
        event: ContentAssetLifecycleEventRecord;
      }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedMaterializeBody>(ctx.request.body, {
          forbiddenKeys: CONTENT_ASSETS_AUTHORITY_FIELDS,
          fields: {
            // The bounded inline-object contract of this surface (the
            // content-addressed store handles the real bytes; base64 is
            // the transport encoding only).
            bytesBase64: stringField({
              pattern: BASE64_PATTERN,
              minLength: 4,
              maxLength: MAX_BASE64_LENGTH,
            }),
          },
        }),
      execute: async (ctx) => {
        await requireVersionInClient(ctx.params.versionId, ctx.params.clientId);
        const body = ctx.validated as ValidatedMaterializeBody;
        const bytes = new Uint8Array(Buffer.from(body.bytesBase64, 'base64'));
        return modules.contentAssets.materializeAssetVersion(
          { versionId: ctx.params.versionId, bytes },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_assets.version_materialized', undefined, {
          version_id: ctx.params.versionId,
          client_id: ctx.params.clientId,
          object_key: ctx.result.record.objectKey,
          object_size: ctx.result.record.objectSize,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_assets.version_materialized',
          targetType: 'content_asset_version',
          targetId: ctx.result.record.versionId,
          afterVersion: ctx.result.record.versionCas,
          idempotencyKey: `content_assets.version_materialized:${ctx.result.record.versionId}:${ctx.result.record.versionCas}`,
          details: {
            objectKey: ctx.result.record.objectKey,
            objectSize: ctx.result.record.objectSize,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          version: serializeVersion(ctx.result.record),
          event: serializeLifecycleEvent(ctx.result.event),
          vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-assets/:versionId/observations —
  // append ONE quality observation (owner|admin; a measured fact from
  // the frozen metric vocabulary — never a score).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-assets/:versionId/observations',
    defineMutationRoute<
      { clientId: string; versionId: string },
      ContentQualityObservationRecord
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedObservationBody>(ctx.request.body, {
          forbiddenKeys: CONTENT_ASSETS_AUTHORITY_FIELDS,
          fields: {
            metric: stringField({ pattern: METRIC_PATTERN }),
            // The numeric value rides as a bounded numeric string when
            // present (the module guard owns the per-metric value-shape
            // semantics — which value class the metric requires).
            numericValue: optionalString({
              pattern: /^\d+(\.\d+)?$/,
              minLength: 1,
              maxLength: 20,
            }),
            textValue: optionalString({ minLength: 1, maxLength: 64 }),
          },
        }),
      execute: async (ctx) => {
        await requireVersionInClient(ctx.params.versionId, ctx.params.clientId);
        const body = ctx.validated as ValidatedObservationBody;
        // The JSON payload carries numbers as strings here (the strict
        // string-field transport) — parse to the numeric value the
        // module guard validates (finite, non-negative, ratio-bounded).
        const numericValue = body.numericValue === undefined
          ? null
          : Number(body.numericValue);
        return modules.contentAssets.recordQualityObservation(
          {
            versionId: ctx.params.versionId,
            metric: body.metric as
              | 'duration_ms' | 'width_px' | 'height_px' | 'bitrate_kbps'
              | 'caption_coverage_ratio' | 'language' | 'fps' | 'sample_rate_hz' | 'byte_size',
            numericValue,
            textValue: body.textValue ?? null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_assets.observation_recorded', undefined, {
          version_id: ctx.params.versionId,
          client_id: ctx.params.clientId,
          metric: ctx.result.metric,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_assets.observation_recorded',
          targetType: 'content_asset_quality_observation',
          targetId: ctx.result.observationId,
          idempotencyKey: `content_assets.observation_recorded:${ctx.result.observationId}`,
          details: {
            metric: ctx.result.metric,
            versionId: ctx.result.versionId,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          observation: serializeObservation(ctx.result),
          vocabularyVersion: CONTENT_ASSETS_VOCABULARY_VERSION,
        }),
    }),
  );
}
