/**
 * /api/platform-health/* routes (MKT-066 — Platform Health and
 * Distribution Anomaly Detection: the §11 descriptive evaluation surface).
 *
 *   POST /api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations   run the evaluation (owner|admin; empty body)
 *   GET  /api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations   the account's evaluation tail (any active member)
 *   GET  /api/clients/:clientId/platform-health                                        the client's evaluations (any active member)
 *   GET  /api/platform-health/evaluations/:evaluationId                                one evaluation + the evidence basis behind the verdict (any active member of the owning client)
 *
 * SURFACE DISCIPLINE (the boundary battery): GET/POST ONLY — no PUT, no
 * PATCH, no DELETE (asserted by tests/architecture/platform-health-boundary.test.ts).
 * Evaluations are append-only: a new evaluation is a NEW record. The
 * evaluation command reads NO body (the empty-field shape gate still
 * runs, so no authority field can even be smuggled onto the surface) —
 * the §11 observable-signals-only discipline is STRUCTURAL: there is no
 * route, field or parameter through which a claimed-but-unrecorded
 * provider notice, moderation guess or caller verdict could enter an
 * evaluation. The route family exposes NO enforcement verb of any kind
 * (the module describes; the consumers decide).
 *
 * Server-derived scope posture (implementation-contract §3/§23; the
 * content-intelligence precedent): every surface resolves the caller's
 * authorization context and the canonical scope from durable state
 * BEFORE the module call; the path identifiers only SELECT which durable
 * scope gets resolved (a caller-supplied identifier is never an
 * authorization). Uniform 404 for foreign/unknown/malformed identifiers
 * (no existence oracle — foreign ≡ unknown ≡ malformed); a suspended
 * membership or disabled identity is the 403; anonymous calls fail
 * closed 401 at the authenticator. Provenance is SERVER-DERIVED from the
 * authenticated principal + the ambient correlation context (never a
 * request field; the DTOs reject every provenance-shaped key). The audit
 * details carry ONLY scalar values (the append-guard discipline — the
 * MKT-065 route-fix precedent: array-shaped facts are serialized as
 * deterministic comma-joined strings).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { NotFoundError } from '../platform/errors/errors.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
} from '../platform/http/pipeline.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import { validateObject } from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import { requireClientAccess } from './authorize.ts';
import type { OwnerScope } from '../platform/http/pipeline.ts';
import type {
  PlatformHealthEvaluationDetail,
  PlatformHealthEvaluationRecord,
  PlatformHealthProvenance,
} from '../modules/platform-health/public.ts';
import { PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE } from '../modules/platform-health/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fields that are always server-derived (authority fields): the verdict,
 * its basis and its provenance can never enter through a request body.
 */
const EVALUATION_AUTHORITY_FIELDS = [
  'evaluationId',
  'state',
  'evaluatedState',
  'reasonCodes',
  'confidence',
  'uncertainty',
  'baseline',
  'recommendations',
  'evidenceBasis',
  'signalsConsidered',
  'provenance',
] as const;

// ---------------------------------------------------------------------------
// Server-derived provenance (never a request field)
// ---------------------------------------------------------------------------

function serverProvenance(principal: Principal): PlatformHealthProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Serialization (the honest read-back shapes)
// ---------------------------------------------------------------------------

function serializeEvaluation(record: PlatformHealthEvaluationRecord): Record<string, unknown> {
  return {
    evaluationId: record.evaluationId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    workspaceId: record.workspaceId,
    socialAccountId: record.socialAccountId,
    platformId: record.platformId,
    state: record.evaluatedState,
    confidence: record.confidence,
    uncertainty: record.uncertainty,
    reasonCodes: [...record.reasonCodes],
    baseline: [...record.baseline],
    recommendations: [...record.recommendations],
    evidenceBasis: [...record.evidenceBasis],
    signalsConsidered: record.signalsConsidered,
    vocabularyVersion: record.vocabularyVersion,
    baselineVersion: record.baselineVersion,
    observabilityDisclosure: record.observabilityDisclosure,
    provenance: { ...record.provenance },
    createdAt: record.createdAt,
  };
}

function serializeDetail(detail: PlatformHealthEvaluationDetail): Record<string, unknown> {
  return {
    evaluation: serializeEvaluation(detail.evaluation),
    evidenceIds: [...detail.evidenceIds],
    metricObservationIds: [...detail.metricObservationIds],
    publishAttemptIds: [...detail.publishAttemptIds],
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPlatformHealthRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('platform-health.api');

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

  /** The uniform 404 for malformed/unknown/foreign account ids (no oracle). */
  async function requireAccountInClient(
    clientId: string,
    socialAccountId: string,
  ): Promise<void> {
    if (!UUID_PATTERN.test(socialAccountId)) {
      throw new NotFoundError('social account', socialAccountId);
    }
    const ownership = await modules.socialAccounts.resolveAccountOwnership(socialAccountId);
    if (ownership === null || ownership.scope.clientId !== clientId) {
      throw new NotFoundError('social account', socialAccountId);
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations
  // — THE EVALUATION COMMAND (owner|admin): compose the §11 verdict from
  // OBSERVABLE RECORDS ONLY (the input is exactly the durable ids; the
  // body is empty and every authority-shaped field is rejected). The
  // module fetches the observable surfaces through the five frozen-row
  // public contracts, runs the deterministic pure core and persists ONE
  // append-only evaluation record.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations',
    defineMutationRoute<
      { clientId: string; socialAccountId: string },
      PlatformHealthEvaluationDetail
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      // The evaluation reads NO body: the strict-validation gate still
      // runs (the empty-field shape — the cross-platform-distribution
      // dispatch precedent), so no signal/state/claim field can even be
      // smuggled onto the surface (the §11 discipline is structural).
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: EVALUATION_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        await requireAccountInClient(ctx.params.clientId, ctx.params.socialAccountId);
        return modules.platformHealth.evaluateAccountHealth(
          {
            clientId: ctx.params.clientId,
            socialAccountId: ctx.params.socialAccountId,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('platformhealth.evaluation.recorded', undefined, {
          client_id: ctx.params.clientId,
          social_account_id: ctx.params.socialAccountId,
          evaluation_id: ctx.result.evaluation.evaluationId,
          state: ctx.result.evaluation.evaluatedState,
          confidence: ctx.result.evaluation.confidence,
          reason_codes: ctx.result.evaluation.reasonCodes.join(','),
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'platformhealth.evaluation.recorded',
          targetType: 'platform_health_evaluation',
          targetId: ctx.result.evaluation.evaluationId,
          afterVersion: null,
          idempotencyKey: `platformhealth.evaluation.recorded:${ctx.result.evaluation.evaluationId}`,
          details: {
            clientId: ctx.params.clientId,
            socialAccountId: ctx.params.socialAccountId,
            state: ctx.result.evaluation.evaluatedState,
            confidence: ctx.result.evaluation.confidence,
            // The append guard requires scalar detail values: the
            // closed reason-code set rides as the deterministic
            // comma-joined string (the notification-delivery
            // receiptOutcomes / MKT-065 route-fix precedent).
            reasonCodes: ctx.result.evaluation.reasonCodes.join(','),
            evidenceBasisEntries: ctx.result.evaluation.evidenceBasis.length,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          ...serializeDetail(ctx.result),
          observabilityDisclosure: PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations
  // — the account's evaluation tail (any active member; uniform 404 for
  // unknown/foreign identifiers).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations',
    defineQueryRoute<
      { clientId: string; socialAccountId: string },
      readonly PlatformHealthEvaluationRecord[]
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        await requireAccountInClient(ctx.params.clientId, ctx.params.socialAccountId);
        return modules.platformHealth.listEvaluationsForAccount(
          ctx.params.clientId,
          ctx.params.socialAccountId,
        );
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          socialAccountId: ctx.params.socialAccountId,
          evaluations: ctx.result.map(serializeEvaluation),
          observabilityDisclosure: PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/platform-health — the client's evaluations
  // (any active member; oldest first, bounded).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/platform-health',
    defineQueryRoute<{ clientId: string }, readonly PlatformHealthEvaluationRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.platformHealth.listEvaluationsForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          evaluations: ctx.result.map(serializeEvaluation),
          observabilityDisclosure: PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/platform-health/evaluations/:evaluationId — ONE evaluation +
  // the FK-anchored evidence basis behind the verdict (any active member
  // of the owning client; uniform 404 for unknown/foreign ids).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/platform-health/evaluations/:evaluationId',
    defineQueryRoute<{ evaluationId: string }, PlatformHealthEvaluationDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (!UUID_PATTERN.test(ctx.params.evaluationId)) {
          throw new NotFoundError('platform health evaluation', ctx.params.evaluationId);
        }
        const ownership =
          await modules.platformHealth.resolveEvaluationOwnership(ctx.params.evaluationId);
        if (ownership === null) {
          throw new NotFoundError('platform health evaluation', ctx.params.evaluationId);
        }
        await requireClientAccess(modules, ctx.principal, ownership.scope.clientId);
      },
      execute: async (ctx) => {
        const detail = await modules.platformHealth.getEvaluationDetail(ctx.params.evaluationId);
        if (detail === null) {
          throw new NotFoundError('platform health evaluation', ctx.params.evaluationId);
        }
        return detail;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          ...serializeDetail(ctx.result),
          observabilityDisclosure: PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE,
        }),
    }),
  );
}
