/**
 * /metrics API routes (MKT-014, METRIC-001).
 *
 *   POST   /api/clients/:clientId/metrics            append one normalized metric observation (any active member)
 *   GET    /api/clients/:clientId/metrics            list the Client's observation ledger (any active member)
 *   GET    /api/metrics/:observationId               read one observation (member of the OWNING agency)
 *
 * There is deliberately NO update and NO delete route: observations are
 * append-oriented and immutable (METRIC-001: "immutable rows; corrections
 * are new rows") — a correction is a NEW append (e.g. quality='restated')
 * referencing the same metric identity.
 *
 * /metrics owns NO provider state (INT-001 posture): provider data ARRIVES
 * here as already-normalized, source-tagged observation payloads; the
 * provider adapters/cursors are MKT-023/024 behind /integrations.
 *
 * PROVENANCE IS SERVER-DERIVED on every append: actor from the
 * authenticated principal, correlation from the ambient correlation
 * context, recording system ('api') and recordedAt from the module clock.
 * The RETRIEVAL timestamp (retrievedAt — when the platform saw the
 * observation) is likewise SERVER-DERIVED: the DTO rejects it and the
 * module stamps its clock (future server-side integration emitters pass
 * the true retrieval moment through the module API, never the HTTP body).
 * The caller declares the OBSERVATION timestamp (observedAt — when the
 * metric was true) only; the two never collapse (METRIC-001 acceptance).
 * The request DTOs reject every other provenance-/identity-/ownership-
 * shaped authority field — a caller can never supply actor, correlation,
 * identity or timestamps of the platform's own recording.
 *
 * Authorization follows the established hard-boundary posture: the owning
 * Client is resolved from durable state BEFORE authorize (uniform 404 for
 * unknown/foreign identifiers — no cross-tenant oracle), and every
 * observation-scoped route resolves the canonical owner chain
 * observation → client → agency before any dependent traversal.
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
import {
  numberField,
  optionalRecordField,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import { requireClientAccess, requireMetricAccess } from './authorize.ts';
import type { MetricObservationRecord } from '../modules/metrics/public.ts';

const METRIC_QUALITY_PATTERN = /^(ok|partial|estimated|restated|suspect)$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Fields that are always server-derived on append — plus every
 * material-shaped key is rejected so nothing secret can even be smuggled
 * into the top level of a metrics payload (§21 defense in depth beyond the
 * module's dimensions guard).
 */
const METRIC_CREATE_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/bookkeeping.
  'observationId',
  'metricId',
  'clientId',
  'agencyId',
  'version',
  'status',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Provenance is a SERVER-DERIVED dimension — never a request field.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  // The retrieval timestamp (when the platform saw the observation) is
  // SERVER-DERIVED: HTTP callers declare observedAt (when the metric was
  // true) only — the module stamps retrievedAt from its clock.
  'retrievedAt',
  // Material-shaped keys are rejected outright on the metrics surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'accessKey',
] as const;

/**
 * SERVER-DERIVED provenance for HTTP appends: actor from the authenticated
 * principal, correlation from the ambient correlation context, recording
 * system 'api'. No value in here is reachable from the request body (the
 * DTO rejects every provenance-shaped key). Mirrors the evidence routes.
 */
function serverProvenance(principal: Principal): {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
} {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

type ValidatedMetricAppend = {
  readonly metricName: string;
  readonly dimensions: Record<string, unknown> | undefined;
  readonly value: number;
  readonly unit: string;
  readonly sourceSystem: string;
  readonly sourceRef: string | undefined;
  readonly observedAt: string;
  readonly quality: string;
  readonly aggregationMethod: string | undefined;
  readonly evidenceRef: string | undefined;
  readonly workspaceId: string | undefined;
};

function serializeObservation(record: MetricObservationRecord): Record<string, unknown> {
  return {
    observationId: record.observationId,
    clientId: record.clientId,
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    metricName: record.metricName,
    dimensions: record.dimensions,
    value: record.value,
    unit: record.unit,
    source: {
      system: record.source.system,
      ...(record.source.ref === null ? {} : { ref: record.source.ref }),
    },
    observedAt: record.observedAt,
    retrievedAt: record.retrievedAt,
    ...(record.evidenceRef === null ? {} : { evidenceRef: record.evidenceRef }),
    quality: record.quality,
    ...(record.aggregationMethod === null ? {} : { aggregationMethod: record.aggregationMethod }),
    provenance: {
      actor: record.provenance.actor,
      recordedVia: record.provenance.recordedVia,
      correlationId: record.provenance.correlationId,
      ...(record.provenance.causationId === null
        ? {}
        : { causationId: record.provenance.causationId }),
      recordedAt: record.provenance.recordedAt,
    },
  };
}

export function registerMetricsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('metrics.api');

  /** Resolves the canonical Client owner scope; 404 BEFORE dependent traversal. */
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

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/metrics — APPEND one immutable normalized
  // metric observation (the only creation path). Client ownership comes from
  // the PATH and is resolved canonically BEFORE authorization; the optional
  // workspaceId is scope INPUT validated against canonical workspace
  // ownership inside the module — never an authorization. Identity,
  // provenance, the retrieval timestamp and the recording timestamp are
  // server-derived; the caller declares the source mapping (source system/
  // ref, the metric identity, the value+unit, observedAt, the optional
  // evidenceRef and the data-quality posture) only.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/metrics',
    defineMutationRoute<{ clientId: string }, MetricObservationRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<ValidatedMetricAppend>(ctx.request.body, {
          forbiddenKeys: METRIC_CREATE_AUTHORITY_FIELDS,
          fields: {
            metricName: stringField({ minLength: 1, maxLength: 200 }),
            dimensions: optionalRecordField({ maxDepthKeys: 20 }),
            value: numberField(),
            unit: stringField({ minLength: 1, maxLength: 64 }),
            sourceSystem: stringField({ minLength: 1, maxLength: 100 }),
            sourceRef: optionalString({ minLength: 1, maxLength: 512 }),
            observedAt: stringField({ pattern: ISO_TIMESTAMP_PATTERN }),
            quality: stringField({ pattern: METRIC_QUALITY_PATTERN }),
            aggregationMethod: optionalString({ minLength: 1, maxLength: 100 }),
            evidenceRef: optionalString({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            workspaceId: optionalString({ minLength: 36, maxLength: 36 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedMetricAppend;
        return modules.metrics.appendMetricObservation(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId === undefined ? null : body.workspaceId,
            metricName: body.metricName,
            dimensions: (body.dimensions ?? {}) as Record<string, string | number | boolean>,
            value: body.value,
            unit: body.unit,
            source: {
              system: body.sourceSystem,
              ref: body.sourceRef === undefined ? null : body.sourceRef,
            },
            observedAt: body.observedAt,
            // The retrieval timestamp is SERVER-DERIVED for HTTP appends —
            // the module stamps its clock (the DTO rejects retrievedAt).
            retrievedAt: null,
            evidenceRef: body.evidenceRef === undefined ? null : body.evidenceRef,
            quality: body.quality as MetricObservationRecord['quality'],
            aggregationMethod: body.aggregationMethod === undefined ? null : body.aggregationMethod,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('metrics.observation.appended', undefined, {
          observation_id: ctx.result.observationId,
          client_id: ctx.result.clientId,
          workspace_id: ctx.result.workspaceId,
          metric_name: ctx.result.metricName,
          source_system: ctx.result.source.system,
          quality: ctx.result.quality,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'metrics.observation.appended',
          targetType: 'metric_observation',
          targetId: ctx.result.observationId,
          idempotencyKey: `metrics.observation.appended:${ctx.result.observationId}`,
          details: {
            metricName: ctx.result.metricName,
            sourceSystem: ctx.result.source.system,
            quality: ctx.result.quality,
            unit: ctx.result.unit,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeObservation(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/metrics — the Client's append-only metric
  // observation ledger, newest first (immutable history stays readable).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/metrics',
    defineQueryRoute<{ clientId: string }, readonly MetricObservationRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.metrics.listMetricObservationsForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          observations: ctx.result.map(serializeObservation),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/metrics/:observationId — read one observation. Cross-tenant/
  // unknown/deleted-client → uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/metrics/:observationId',
    defineQueryRoute<{ observationId: string }, MetricObservationRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMetricAccess(modules, ctx.principal, ctx.params.observationId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.metrics.resolveMetricObservationOwnership(
          ctx.params.observationId,
        );
        if (ownership === null) {
          throw new NotFoundError('metric observation', ctx.params.observationId);
        }
        return ownership.observation;
      },
      respond: (ctx) => jsonResponse(200, serializeObservation(ctx.result)),
    }),
  );
}
