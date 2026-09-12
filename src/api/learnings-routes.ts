/**
 * /learnings API routes (MKT-016, LEARN-001).
 *
 *   POST /api/clients/:clientId/learnings              append one Learning (any active member)
 *   GET  /api/clients/:clientId/learnings              list the Client's Learning ledger (any active member)
 *   GET  /api/learnings/:learningId                    read one Learning, superseded/retired included (member of the OWNING agency)
 *   POST /api/learnings/:learningId/relationships      record one contradiction/supersession/retirement (owner|admin of the OWNING agency)
 *   GET  /api/learnings/:learningId/relationships      the append-only relationship chain (member of the OWNING agency)
 *
 * There is deliberately NO update and NO delete route: Learning rows are
 * FULLY immutable (DB triggers reject UPDATE and DELETE — the state is
 * DERIVED from the relationship history, never stored), and every state
 * change is a NEW append-only relationship row (LEARN-AC-02 — history is
 * never erased, "Learning is never retroactive deletion of evidence").
 *
 * PROVENANCE IS SERVER-DERIVED on every write: actor from the
 * authenticated principal, correlation from the ambient correlation
 * context, recording system ('api') and recordedAt from the module clock.
 * The request DTOs reject every provenance-shaped authority field AND
 * every state/relationship authority field (status, supersededBy) — a
 * caller can never supply identity, ownership, provenance or derived
 * state. On the CREATE surface the caller declares the Learning content
 * only (statement, applicability conditions, supporting references, the
 * descriptive confidence); on the RELATIONSHIP surface the caller names
 * the kind and (for contradiction/supersession) the later learning.
 *
 * Authorization follows the established hard-boundary posture: the owning
 * Client is resolved from durable state BEFORE authorize (uniform 404 for
 * unknown/foreign identifiers — no cross-tenant oracle), and every
 * learning-scoped route resolves the canonical owner chain
 * learning → client → agency before any dependent traversal.
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
  optionalArrayField,
  optionalNumber,
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import { requireClientAccess, requireLearningAccess } from './authorize.ts';
import type {
  LearningRecord,
  LearningRelationshipKind,
  LearningRelationshipRecord,
} from '../modules/learnings/public.ts';

const LEARNING_RELATIONSHIP_KIND_PATTERN = /^(contradicts|supersedes|retires)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Fields that are always server-derived on append — plus every
 * material-shaped key is rejected so nothing secret can even be smuggled
 * into the top level of a learnings payload (§21 defense in depth beyond
 * the module's applicability guard). The DERIVED state and successor
 * pointer are authority fields too: a caller can never declare a
 * Learning superseded/contradicted/retired by body — only the explicit
 * relationship command moves derived state.
 */
const LEARNING_CREATE_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/bookkeeping.
  'learningId',
  'clientId',
  'agencyId',
  'version',
  'status',
  'lifecycleState',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Derived relationship state — never caller-supplied.
  'supersededBy',
  'contradictedBy',
  'retiredAt',
  // Provenance is a SERVER-DERIVED dimension — never a request field.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  // Material-shaped keys are rejected outright on the learnings surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'accessKey',
] as const;

/**
 * Fields that are always server-derived on a relationship recording: the
 * caller names the kind and (for contradiction/supersession ONLY) the
 * later learning — everything else is authority the platform owns.
 */
const LEARNING_RELATIONSHIP_AUTHORITY_FIELDS = [
  'learningId',
  'relationshipId',
  'clientId',
  'agencyId',
  'version',
  'fromLearningId',
  'status',
  'supersededBy',
  'createdAt',
  'updatedAt',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'provenance',
  'actor',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'accessKey',
] as const;

/**
 * SERVER-DERIVED provenance for HTTP writes: actor from the authenticated
 * principal, correlation from the ambient correlation context, recording
 * system 'api'. No value in here is reachable from the request body (the
 * DTOs reject every provenance-shaped key). Mirrors the evidence/metrics/
 * experiments routes.
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

type ValidatedLearningCreate = {
  readonly statement: string;
  readonly applicability: Record<string, unknown>;
  readonly evidenceRefs: string[] | undefined;
  readonly experimentRefs: string[] | undefined;
  readonly confidence: number | undefined;
  readonly workspaceId: string | undefined;
};

type ValidatedRelationship = {
  readonly kind: string;
  readonly toLearningId: string | undefined;
};

function serializeLearning(record: LearningRecord): Record<string, unknown> {
  return {
    learningId: record.learningId,
    clientId: record.clientId,
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    statement: record.statement,
    applicability: record.applicability,
    evidenceRefs: record.evidenceRefs,
    experimentRefs: record.experimentRefs,
    ...(record.confidence === null ? {} : { confidence: record.confidence }),
    // The DERIVED state (implementation-contract §17) — computed from the
    // relationship history, never stored, never caller-supplied.
    status: record.status,
    ...(record.supersededBy === null ? {} : { supersededBy: record.supersededBy }),
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

function serializeRelationship(record: LearningRelationshipRecord): Record<string, unknown> {
  return {
    relationshipId: record.relationshipId,
    fromLearningId: record.fromLearningId,
    ...(record.toLearningId === null ? {} : { toLearningId: record.toLearningId }),
    kind: record.kind,
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

export function registerLearningsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('learnings.api');

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

  /** Resolves the canonical Learning owner scope; 404 BEFORE dependent traversal. */
  async function learningOwner(learningId: string): Promise<OwnerScope> {
    const ownership = await modules.learnings.resolveLearningOwnership(learningId);
    if (ownership === null) {
      throw new NotFoundError('learning', learningId);
    }
    return {
      kind: 'learning',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
      learningId: ownership.scope.learningId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/learnings — APPEND one immutable Learning
  // record (the only creation path). Client ownership comes from the PATH
  // and is resolved canonically BEFORE authorization; the optional
  // workspaceId is scope INPUT validated against canonical workspace
  // ownership inside the module — never an authorization. Identity,
  // provenance, derived state and timestamps are server-derived; the
  // caller declares the Learning content only (statement, applicability
  // conditions, supporting references, the descriptive confidence). The
  // module validates the supporting references THROUGH the /evidence and
  // /experiments public contracts (same-Client, uniform 404; experiment
  // references must have concluded).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/learnings',
    defineMutationRoute<{ clientId: string }, LearningRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<ValidatedLearningCreate>(ctx.request.body, {
          forbiddenKeys: LEARNING_CREATE_AUTHORITY_FIELDS,
          fields: {
            statement: stringField({ minLength: 1, maxLength: 2000 }),
            applicability: recordField({ maxDepthKeys: 20 }),
            evidenceRefs: optionalArrayField({
              maxItems: 50,
              item: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            }),
            experimentRefs: optionalArrayField({
              maxItems: 50,
              item: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            }),
            confidence: optionalNumber({ min: 0, max: 1 }),
            workspaceId: optionalString({ minLength: 36, maxLength: 36 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedLearningCreate;
        return modules.learnings.createLearning(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId === undefined ? null : body.workspaceId,
            statement: body.statement,
            // Shape entry only here; the module append guard validates the
            // applicability conditions (scalar values + §21) fully.
            applicability: body.applicability as LearningRecord['applicability'],
            evidenceRefs: body.evidenceRefs ?? [],
            experimentRefs: body.experimentRefs ?? [],
            confidence: body.confidence === undefined ? null : body.confidence,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('learnings.learning.appended', undefined, {
          learning_id: ctx.result.learningId,
          client_id: ctx.result.clientId,
          workspace_id: ctx.result.workspaceId,
          evidence_ref_count: ctx.result.evidenceRefs.length,
          experiment_ref_count: ctx.result.experimentRefs.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'learnings.learning.appended',
          targetType: 'learning',
          targetId: ctx.result.learningId,
          idempotencyKey: `learnings.learning.appended:${ctx.result.learningId}`,
          details: {
            evidenceRefCount: ctx.result.evidenceRefs.length,
            experimentRefCount: ctx.result.experimentRefs.length,
            workspaceScoped: ctx.result.workspaceId !== null,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeLearning(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/learnings — the Client's append-only
  // Learning ledger, newest first (superseded and retired learnings
  // included: immutable history stays readable, each with its DERIVED
  // status and successor pointer).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/learnings',
    defineQueryRoute<{ clientId: string }, readonly LearningRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.learnings.listLearningsForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          learnings: ctx.result.map(serializeLearning),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/learnings/:learningId — read one Learning. Cross-tenant/
  // unknown/deleted-client → uniform 404. Superseded and retired learnings
  // are readable history (the derived state + successor pointer ride the
  // response).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/learnings/:learningId',
    defineQueryRoute<{ learningId: string }, LearningRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireLearningAccess(modules, ctx.principal, ctx.params.learningId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.learnings.resolveLearningOwnership(ctx.params.learningId);
        if (ownership === null) {
          throw new NotFoundError('learning', ctx.params.learningId);
        }
        return ownership.learning;
      },
      respond: (ctx) => jsonResponse(200, serializeLearning(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/learnings/:learningId/relationships — record ONE
  // contradiction / supersession / retirement against the TARGET learning
  // in the path. This appends a NEW immutable relationship row
  // (LEARN-AC-02): the original Learning row is never modified — its
  // derived state changes because history gained a row, never because a
  // column was rewritten. The caller names the kind and (for
  // 'contradicts'/'supersedes') the LATER learning id; 'retires' carries
  // no later learning. Requires owner|admin|platform admin — explicit
  // authorized history-making operations.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/learnings/:learningId/relationships',
    defineMutationRoute<{ learningId: string }, LearningRelationshipRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => learningOwner(params.learningId),
      authorize: async (ctx) => {
        await requireLearningAccess(modules, ctx.principal, ctx.params.learningId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedRelationship>(ctx.request.body, {
          forbiddenKeys: LEARNING_RELATIONSHIP_AUTHORITY_FIELDS,
          fields: {
            kind: stringField({ pattern: LEARNING_RELATIONSHIP_KIND_PATTERN }),
            toLearningId: optionalString({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedRelationship;
        return modules.learnings.recordLearningRelationship(
          ctx.params.learningId,
          {
            kind: body.kind as LearningRelationshipKind,
            toLearningId: body.toLearningId === undefined ? null : body.toLearningId,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('learnings.learning.relationship_recorded', undefined, {
          learning_id: ctx.result.fromLearningId,
          relationship_id: ctx.result.relationshipId,
          kind: ctx.result.kind,
          to_learning_id: ctx.result.toLearningId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'learnings.learning.relationship_recorded',
          targetType: 'learning_relationship',
          targetId: ctx.result.relationshipId,
          // Deterministic per (relationship row): each append is a fresh
          // immutable history row, so caller retries after an audit
          // failure converge to one audit row.
          idempotencyKey: `learnings.learning.relationship_recorded:${ctx.result.relationshipId}`,
          details: {
            kind: ctx.result.kind,
            fromLearningId: ctx.result.fromLearningId,
            toLearningId: ctx.result.toLearningId,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeRelationship(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/learnings/:learningId/relationships — the FULL append-only
  // relationship chain around one learning, oldest first: every
  // contradiction/supersession/retirement recorded AGAINST it and every
  // relationship IT recorded against earlier learnings (LEARN-AC-02 —
  // history queries return the full chain; nothing is ever dropped).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/learnings/:learningId/relationships',
    defineQueryRoute<{ learningId: string }, readonly LearningRelationshipRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireLearningAccess(modules, ctx.principal, ctx.params.learningId);
      },
      execute: async (ctx) => {
        return modules.learnings.listLearningRelationships(ctx.params.learningId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          learningId: ctx.params.learningId,
          relationships: ctx.result.map(serializeRelationship),
        }),
    }),
  );
}
