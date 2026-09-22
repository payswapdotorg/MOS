/**
 * /api/clients/:clientId/cross-platform-distribution/* routes (MKT-065 —
 * the Cross-Platform Distribution surface: the distribution plans + the
 * fan-out dispatch + the measurement tail).
 *
 *   POST  /api/clients/:clientId/cross-platform-distribution/plans                       record one distribution plan (owner|admin) — the §5 chain declaration (source asset → transformation plan → N destination variants)
 *   GET   /api/clients/:clientId/cross-platform-distribution/plans                       the client's plans (any active member)
 *   GET   /api/clients/:clientId/cross-platform-distribution/plans/:planId               the composed plan detail — destinations + publications + the full lineage (any active member)
 *   POST  /api/clients/:clientId/cross-platform-distribution/plans/:planId/dispatch      THE FAN-OUT DISPATCH (owner|admin) — the fail-closed per-destination execution (063 gate → capability → policy → 056 submitPublish)
 *   POST  /api/clients/:clientId/cross-platform-distribution/plans/:planId/measurements  append one measurement reference (owner|admin) — the §5 Measurement tail as data
 *
 * There is deliberately NO update route (plan/destination declarations are
 * immutable — the migration-055 triggers reject it at the database), NO
 * delete route (the lineage is append-only) and NO route of ANY kind that
 * bypasses the composed gates: the dispatch route is the ONLY publication
 * surface and it always runs the 063 rights gate, the per-platform
 * capability validation and the dispatch policy gate BEFORE any 056
 * submitPublish (there is no "force publish" verb — fail-closed by
 * construction). NO route mutates a mission (the anchor is read-only),
 * re-evaluates rights (the 063 authority stays sole) or touches the 056
 * ledger directly (the /social-accounts routes own their own surface).
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: the DTOs reject
 * identity/ownership/outcome/provenance fields AND every material-shaped
 * key (§21). Computed outcomes (the gate verdicts, the capability
 * resolutions, the policy decisions, the publish states, the provider
 * refs, the derived idempotency keys, the input digest) have NO input
 * surface at all — they are derived exclusively by the module core from
 * the consumed public-contract data. The tenant scope chain is
 * server-derived from the canonical /clients ownership resolution; the
 * destination platform ids are FROZEN from the resolved account records,
 * never caller-supplied.
 *
 * Authorization follows the established hard-boundary posture: every
 * route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /clients chain; the plan-scoped routes
 * additionally resolve canonical plan ownership and yield a UNIFORM 404
 * for unknown/foreign/mismatched identifiers — no cross-tenant oracle)
 * and authorizes against the SAME /agencies membership authority as
 * every other scoped check.
 */

import { NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import {
  arrayField,
  objectField,
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { ApplicationModules } from './application.ts';
import { requireClientAccess, requireWorkspaceAccess } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  CrossPlatformDistributionProvenance,
  DistributionDestinationRecord,
  DistributionEventRecord,
  DistributionPlanDetail,
  DistributionPlanRecord,
  DistributionPublicationRecord,
} from '../modules/cross-platform-distribution/public.ts';
import {
  CROSS_PLATFORM_DISTRIBUTION_VOCABULARY_VERSION,
} from '../modules/cross-platform-distribution/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_REF_PATTERN =
  /^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TARGET_FORMAT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Fields always server-derived on the cross-platform-distribution
 * surfaces — plus every material-shaped key is rejected (§21: nothing
 * secret can even be smuggled into a plan; the media assets are DERIVED
 * from the resolved versioned asset records, never declared).
 */
const DISTRIBUTION_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/outcome.
  'planId',
  'destinationId',
  'publicationId',
  'eventId',
  'agencyId',
  'clientId',
  'platformId',
  'sourceVersionId',
  'assetVersionId',
  'planState',
  'destinationStatus',
  'idempotencyKey',
  'publishAttemptId',
  'publishState',
  'failureCode',
  'providerPublishId',
  'providerContentId',
  'publishedAt',
  'duplicate',
  'inputDigest',
  'eventSeq',
  'eventKind',
  'payload',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'createdAt',
  'updatedAt',
  'version',
  'position',
  'mediaAssets',
  'destinations',
  'events',
  'publications',
  // Material-shaped keys are rejected outright on every surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
  'credentialMaterial',
] as const;
// NOTE: `workspaceId` and `missionId` are deliberately NOT on the
// forbidden list — they are the OPTIONAL validated selection inputs of
// the plan declaration (the experiment-analysis precedent): the route
// validates the workspace against canonical ownership BEFORE the module
// call, and the mission anchor resolves read-only through the module.

/** The nested output DTO's forbidden set (the caller names exactly
 *  assetRef + variantLabel — everything else is server-derived). */
const OUTPUT_AUTHORITY_FIELDS = [
  'versionId',
  'mediaKind',
  'displayName',
  'contentType',
  'objectDigest',
  'provenance',
  'created_at',
];

/** The nested destination DTO's forbidden set (the caller names exactly
 *  the account, the format, the asset ref and the publish request —
 *  everything else is server-derived). */
const DESTINATION_AUTHORITY_FIELDS = [
  'destinationId',
  'planId',
  'clientId',
  'position',
  'platformId',
  'assetVersionId',
  'idempotencyKey',
  'destinationStatus',
  'provenance',
  'mediaAssets',
  'version',
  'createdAt',
  'updatedAt',
];

/** The nested publish-request DTO's forbidden set (the 056 request shape minus the derived media assets). */
const PUBLISH_REQUEST_AUTHORITY_FIELDS = [
  'mediaAssets',
  'idempotencyKey',
  'publishState',
  'failureCode',
  'providerPublishId',
  'providerContentId',
  'provenance',
];

/**
 * SERVER-DERIVED provenance for HTTP-surface distribution mutations:
 * actor from the authenticated principal, correlation from the ambient
 * correlation context, recording surface 'api'. No value in here is
 * reachable from the request body (every DTO rejects provenance-shaped
 * keys).
 */
function serverProvenance(principal: Principal): CrossPlatformDistributionProvenance {
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
  provenance: CrossPlatformDistributionProvenance & { readonly recordedAt?: string },
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

function serializePlan(plan: DistributionPlanRecord): Record<string, unknown> {
  return {
    planId: plan.planId,
    agencyId: plan.agencyId,
    clientId: plan.clientId,
    ...(plan.workspaceId === null ? {} : { workspaceId: plan.workspaceId }),
    ...(plan.missionId === null ? {} : { missionId: plan.missionId }),
    sourceAssetRef: plan.sourceAssetRef,
    sourceVersionId: plan.sourceVersionId,
    transformationPlan: plan.transformationPlan,
    planState: plan.planState,
    inputDigest: plan.inputDigest,
    provenance: serializeProvenance(plan.provenance),
    version: plan.version,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function serializeDestination(
  destination: DistributionDestinationRecord,
): Record<string, unknown> {
  return {
    destinationId: destination.destinationId,
    planId: destination.planId,
    clientId: destination.clientId,
    position: destination.position,
    socialAccountId: destination.socialAccountId,
    platformId: destination.platformId,
    assetRef: destination.assetRef,
    assetVersionId: destination.assetVersionId,
    targetFormat: destination.targetFormat,
    publishRequest: destination.publishRequest,
    idempotencyKey: destination.idempotencyKey,
    destinationStatus: destination.destinationStatus,
    provenance: serializeProvenance(destination.provenance),
    version: destination.version,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
  };
}

function serializePublication(
  publication: DistributionPublicationRecord,
): Record<string, unknown> {
  return {
    publicationId: publication.publicationId,
    planId: publication.planId,
    destinationId: publication.destinationId,
    clientId: publication.clientId,
    socialAccountId: publication.socialAccountId,
    publishAttemptId: publication.publishAttemptId,
    idempotencyKey: publication.idempotencyKey,
    publishState: publication.publishState,
    ...(publication.failureCode === null ? {} : { failureCode: publication.failureCode }),
    ...(publication.providerPublishId === null
      ? {}
      : { providerPublishId: publication.providerPublishId }),
    ...(publication.providerContentId === null
      ? {}
      : { providerContentId: publication.providerContentId }),
    ...(publication.publishedAt === null ? {} : { publishedAt: publication.publishedAt }),
    duplicate: publication.duplicate,
    provenance: serializeProvenance(publication.provenance),
  };
}

function serializeEvent(event: DistributionEventRecord): Record<string, unknown> {
  return {
    eventId: event.eventId,
    planId: event.planId,
    ...(event.destinationId === null ? {} : { destinationId: event.destinationId }),
    clientId: event.clientId,
    eventSeq: event.eventSeq,
    eventKind: event.eventKind,
    payload: event.payload,
    provenance: serializeProvenance(event.provenance),
  };
}

function serializeDetail(detail: DistributionPlanDetail): Record<string, unknown> {
  return {
    plan: serializePlan(detail.plan),
    destinations: detail.destinations.map(serializeDestination),
    publications: detail.publications.map(serializePublication),
    events: detail.events.map(serializeEvent),
    vocabularyVersion: CROSS_PLATFORM_DISTRIBUTION_VOCABULARY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** The validated plan DTO (the strict-validation output type). */
type ValidatedPlanBody = {
  readonly sourceAssetRef: string;
  readonly transformationDescription: string;
  readonly transformationOutputs: {
    readonly assetRef: string;
    readonly variantLabel: string;
  }[];
  readonly missionId: string | undefined;
  readonly workspaceId: string | undefined;
  readonly destinationVariants: {
    readonly socialAccountId: string;
    readonly targetFormat: string;
    readonly assetRef: string;
    readonly publishRequest: {
      readonly contentType: string;
      readonly payload: Record<string, unknown>;
      readonly attribution: Record<string, unknown>;
      readonly scheduledFor: string | undefined;
    };
  }[];
};

/** The validated measurement DTO. */
type ValidatedMeasurementBody = {
  readonly measurementRef: string;
  readonly note: string | undefined;
  readonly destinationId: string | undefined;
};

export function registerCrossPlatformDistributionRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('cross-platform-distribution.api');

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
   * The canonical PLAN owner resolution for every plan-scoped route: the
   * module resolves the plan + its owning chain; a plan that does not
   * exist, or that belongs to ANOTHER Client than the path's, is the
   * SAME uniform 404 (a foreign identifier is not a traversal oracle).
   * Malformed ids are the same uniform 404.
   */
  async function requirePlanInClient(planId: string, clientId: string) {
    if (!UUID_PATTERN.test(planId)) {
      throw new NotFoundError('distribution_plan', planId);
    }
    const ownership =
      await modules.crossPlatformDistribution.resolveDistributionPlanOwnership(planId);
    if (ownership === null || ownership.plan.clientId !== clientId) {
      throw new NotFoundError('distribution_plan', planId);
    }
    return ownership;
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/cross-platform-distribution/plans — record
  // one distribution plan (owner|admin): the §5 chain declaration. Every
  // asset reference resolves to its EXPLICIT 064 version record inside
  // the module (never a floating pointer); the destination platform ids
  // are frozen from the resolved account records.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/cross-platform-distribution/plans',
    defineMutationRoute<{ clientId: string }, DistributionPlanDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedPlanBody>(ctx.request.body, {
          forbiddenKeys: DISTRIBUTION_AUTHORITY_FIELDS,
          fields: {
            sourceAssetRef: stringField({ pattern: ASSET_REF_PATTERN }),
            transformationDescription: stringField({ minLength: 1, maxLength: 2000 }),
            transformationOutputs: arrayField({
              minItems: 0,
              maxItems: 16,
              item: objectField({
                forbiddenKeys: OUTPUT_AUTHORITY_FIELDS,
                fields: {
                  assetRef: stringField({ pattern: ASSET_REF_PATTERN }),
                  variantLabel: stringField({ minLength: 1, maxLength: 64 }),
                },
              }),
            }),
            // The OPTIONAL read-only mission anchor (resolved through the
            // /growth-missions public contract inside the module).
            missionId: optionalString({ pattern: UUID_PATTERN }),
            // The OPTIONAL workspace narrowing — resolved canonically
            // here first (uniform 404 on foreign).
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
            destinationVariants: arrayField({
              minItems: 1,
              maxItems: 32,
              item: objectField({
                forbiddenKeys: DESTINATION_AUTHORITY_FIELDS,
                fields: {
                  socialAccountId: stringField({ pattern: UUID_PATTERN }),
                  targetFormat: stringField({ pattern: TARGET_FORMAT_PATTERN }),
                  assetRef: stringField({ pattern: ASSET_REF_PATTERN }),
                  publishRequest: objectField({
                    forbiddenKeys: PUBLISH_REQUEST_AUTHORITY_FIELDS,
                    fields: {
                      contentType: stringField({ pattern: CONTENT_TYPE_PATTERN }),
                      payload: recordField({ maxDepthKeys: 64 }),
                      attribution: recordField({ maxDepthKeys: 64 }),
                      scheduledFor: optionalString({ pattern: ISO_TIMESTAMP_PATTERN }),
                    },
                  }),
                },
              }),
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedPlanBody;
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        if (body.workspaceId !== undefined) {
          await requireWorkspaceAccess(modules, ctx.principal, body.workspaceId);
        }
        return modules.crossPlatformDistribution.createDistributionPlan(
          {
            agencyId: ownership.client.agencyId,
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            missionId: body.missionId ?? null,
            sourceAssetRef: body.sourceAssetRef,
            transformationPlan: {
              description: body.transformationDescription,
              outputs: body.transformationOutputs,
            },
            destinations: body.destinationVariants.map((variant) => ({
              socialAccountId: variant.socialAccountId,
              targetFormat: variant.targetFormat,
              assetRef: variant.assetRef,
              publishRequest: {
                contentType: variant.publishRequest.contentType,
                payload: variant.publishRequest.payload,
                attribution: variant.publishRequest.attribution,
                scheduledFor: variant.publishRequest.scheduledFor ?? null,
              },
            })),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('distribution.plan_created', undefined, {
          client_id: ctx.params.clientId,
          plan_id: ctx.result.plan.planId,
          destinations: ctx.result.destinations.length,
          source_asset_ref: ctx.result.plan.sourceAssetRef,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'distribution.plan_created',
          targetType: 'distribution_plan',
          targetId: ctx.result.plan.planId,
          afterVersion: ctx.result.plan.version,
          idempotencyKey: `distribution.plan_created:${ctx.result.plan.planId}`,
          details: {
            sourceAssetRef: ctx.result.plan.sourceAssetRef,
            destinations: ctx.result.destinations.length,
            inputDigest: ctx.result.plan.inputDigest,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/cross-platform-distribution/plans — the
  // client's plans, newest first (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/cross-platform-distribution/plans',
    defineQueryRoute<{ clientId: string }, readonly DistributionPlanRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.crossPlatformDistribution.listDistributionPlansForClient(ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          plans: ctx.result.map(serializePlan),
          vocabularyVersion: CROSS_PLATFORM_DISTRIBUTION_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/cross-platform-distribution/plans/:planId
  // — the composed plan detail: the record + the destination variants +
  // the publication links + the complete append-only lineage (any active
  // member; uniform 404 for unknown/foreign identifiers).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/cross-platform-distribution/plans/:planId',
    defineQueryRoute<
      { clientId: string; planId: string },
      DistributionPlanDetail
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        await requirePlanInClient(ctx.params.planId, ctx.params.clientId);
        const detail = await modules.crossPlatformDistribution.getDistributionPlanDetail(
          ctx.params.planId,
        );
        if (detail === null) {
          throw new NotFoundError('distribution_plan', ctx.params.planId);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/cross-platform-distribution/plans/:planId/dispatch
  // — THE FAN-OUT DISPATCH (owner|admin): the fail-closed per-destination
  // execution. The 063 rights gate, the per-platform capability
  // validation and the dispatch policy gate all run INSIDE the module
  // before any 056 submitPublish — this route exposes NO way to skip
  // them (fail-closed by construction). Idempotent: a re-dispatch
  // converges on the 056 fence (zero provider traffic for attempted
  // destinations) and re-evaluates honestly for non-attempted ones.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/cross-platform-distribution/plans/:planId/dispatch',
    defineMutationRoute<{ clientId: string; planId: string }, DistributionPlanDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      // The dispatch reads NO body: the strict-validation gate still runs
      // (empty-field shape — the content-assets execute precedent), so no
      // authority field can even be smuggled onto the surface.
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: DISTRIBUTION_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        await requirePlanInClient(ctx.params.planId, ctx.params.clientId);
        return modules.crossPlatformDistribution.dispatchDistributionPlan(
          { planId: ctx.params.planId },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('distribution.dispatched', undefined, {
          client_id: ctx.params.clientId,
          plan_id: ctx.params.planId,
          plan_state: ctx.result.plan.planState,
          outcomes: ctx.result.destinations.map(
            (destination) => destination.destinationStatus,
          ),
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'distribution.dispatched',
          targetType: 'distribution_plan',
          targetId: ctx.params.planId,
          afterVersion: ctx.result.plan.version,
          idempotencyKey: `distribution.dispatched:${ctx.params.planId}:${ctx.result.plan.version}`,
          details: {
            planState: ctx.result.plan.planState,
            // MKT-066 (the disclosed MKT-065 route fix): the audit append
            // guard requires JSON-scalar detail values (audit-store's
            // assertValidAuditEvent rejects arrays/objects), so the
            // per-destination outcome list rides as the DETERMINISTIC
            // fan-out-ordered comma-joined status string — the house
            // serialization precedent (notification-delivery's
            // receiptOutcomes / field-agents' specializations join(',')).
            // Position corresponds to fan-out order: the string is
            // lossless over the ordered outcome list (the full per-plan
            // detail stays readable on the plan's own lineage tail).
            outcomes: ctx.result.destinations
              .map((destination) => destination.destinationStatus)
              .join(','),
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/cross-platform-distribution/plans/:planId/measurements
  // — append ONE §5 measurement reference to the lineage tail
  // (owner|admin): the opaque reference the mission/operator layer
  // resolves (the module records measurement references; it never
  // computes measurement).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/cross-platform-distribution/plans/:planId/measurements',
    defineMutationRoute<{ clientId: string; planId: string }, DistributionEventRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedMeasurementBody>(ctx.request.body, {
          forbiddenKeys: DISTRIBUTION_AUTHORITY_FIELDS,
          fields: {
            measurementRef: stringField({ minLength: 1, maxLength: 256 }),
            note: optionalString({ maxLength: 1000 }),
            destinationId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedMeasurementBody;
        await requirePlanInClient(ctx.params.planId, ctx.params.clientId);
        return modules.crossPlatformDistribution.recordMeasurementReference(
          {
            planId: ctx.params.planId,
            destinationId: body.destinationId ?? null,
            measurementRef: body.measurementRef,
            note: body.note ?? null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('distribution.measurement_reference_recorded', undefined, {
          client_id: ctx.params.clientId,
          plan_id: ctx.params.planId,
          event_id: ctx.result.eventId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'distribution.measurement_reference_recorded',
          targetType: 'distribution_plan',
          targetId: ctx.params.planId,
          idempotencyKey: null,
          details: {
            eventId: ctx.result.eventId,
            eventSeq: ctx.result.eventSeq,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          event: serializeEvent(ctx.result),
          vocabularyVersion: CROSS_PLATFORM_DISTRIBUTION_VOCABULARY_VERSION,
        }),
    }),
  );
}
