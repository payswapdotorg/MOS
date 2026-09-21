/**
 * /api/clients/:clientId/content-rights/* routes (MKT-063 — the Content
 * Rights and Provenance surface: the rights records + the publication
 * gate).
 *
 *   POST  /api/clients/:clientId/content-rights                                  register the rights record for an asset ref (owner|admin) — born 'unknown'
 *   GET   /api/clients/:clientId/content-rights                                  the client's rights records (any active member)
 *   GET   /api/clients/:clientId/content-rights/by-asset/:assetRef              the record for one asset ref (any active member)
 *   POST  /api/clients/:clientId/content-rights/gate                             THE PUBLICATION GATE (any active member) — allow / review_required / blocked WITH reasons
 *   POST  /api/clients/:clientId/content-rights/lineage                          record ONE ingredient lineage link (owner|admin)
 *   GET   /api/clients/:clientId/content-rights/lineage/:compositeAssetRef      the composite's lineage links (any active member)
 *   GET   /api/clients/:clientId/content-rights/:rightsRecordId                  one record + its full append-only tails (events, permissions, clearances — any active member)
 *   POST  /api/clients/:clientId/content-rights/:rightsRecordId/transitions      record ONE state transition (owner|admin) — the human_clearance kind IS the review → cleared path
 *   POST  /api/clients/:clientId/content-rights/:rightsRecordId/permissions      append ONE destination-platform permission row (owner|admin)
 *
 * Literal-segment routes (by-asset/gate/lineage) are registered BEFORE
 * the :rightsRecordId patterns: the literal segments sit in the
 * :rightsRecordId position and the router resolves first-match-wins
 * (the jobs-queue precedent).
 *
 * There is deliberately NO update route (recorded facts are immutable —
 * corrections are recorded transition events), NO delete route (rights
 * history is append-only — the migration-051 triggers reject it at the
 * database) and NO publish/dispatch route of ANY kind (boundary rule 4:
 * the gate blocks or refers to review; publishing is MKT-065's
 * execution surface — the gate POST is an EVALUATION, not a
 * publication).
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: the DTOs reject
 * identity/ownership/lifecycle/outcome/provenance fields AND every
 * material-shaped key (§21). The tenant scope chain is server-derived
 * from the canonical /clients ownership resolution; the clearance actor
 * is the authenticated principal (a human identity for the
 * human_clearance path).
 *
 * Authorization follows the established hard-boundary posture: every
 * route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /clients chain; the record-scoped
 * routes additionally resolve canonical rights ownership and yield a
 * UNIFORM 404 for unknown/foreign/mismatched identifiers — no
 * cross-tenant oracle), authorizes against the SAME /agencies
 * membership authority as every other scoped check, and the
 * destination-policy compatibility of every gate evaluation runs
 * behind the module's fail-closed /policies gate.
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
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireClientAccess, requireWorkspaceAccess } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  ContentRightsClearanceRecord,
  ContentRightsEventRecord,
  ContentRightsGateResult,
  ContentRightsLineageRecord,
  ContentRightsPermissionRecord,
  ContentRightsProvenance,
  ContentRightsRecord,
} from '../modules/content-rights/public.ts';
import {
  CONTENT_RIGHTS_VOCABULARY_VERSION,
} from '../modules/content-rights/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_KIND_PATTERN = /^(determination|human_clearance|contestation|revocation|review_denial|re_review_request)$/;
const STATE_PATTERN = /^(owned|license|platform_permitted|cleared|review|blocked|unknown)$/;
const ASSET_KIND_PATTERN = /^(source|composite)$/;
const PERMISSION_PATTERN = /^(permitted|not_permitted)$/;
const PLATFORM_KEY_PATTERN_SRC = /^[a-z][a-z0-9_-]{0,31}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Fields always server-derived on the content-rights surfaces — plus
 * every material-shaped key is rejected (§21: nothing secret can even
 * be smuggled into a rights record; evidence arrives as /evidence
 * REFERENCES resolved through the evidence authority, never as inline
 * payloads).
 */
const CONTENT_RIGHTS_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/lifecycle/outcome.
  'rightsRecordId',
  'eventId',
  'clearanceId',
  'permissionId',
  'lineageLinkId',
  'agencyId',
  'clientId',
  'state',
  'fromState',
  'version',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'createdAt',
  'updatedAt',
  'outcome',
  'reasons',
  'composite',
  'ingredientEvaluations',
  'policyDecisionId',
  'evaluatedAt',
  'vocabularyVersion',
  'event',
  'clearance',
  'record',
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
// NOTE: `workspaceId` is deliberately NOT on the forbidden list — it is
// the OPTIONAL workspace narrowing of the register/lineage inputs (the
// notification-delivery authorize-start precedent): the route validates
// it against canonical workspace ownership BEFORE the module call, so
// it is a validated selection input, never a server-authoritative
// value the caller could forge.

/**
 * SERVER-DERIVED provenance for HTTP-surface content-rights mutations:
 * actor from the authenticated principal, correlation from the ambient
 * correlation context, recording surface 'api'. No value in here is
 * reachable from the request body (every DTO rejects
 * provenance-shaped keys).
 */
function serverProvenance(principal: Principal): ContentRightsProvenance {
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
  provenance: ContentRightsRecord['provenance'],
): Record<string, unknown> {
  return {
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    ...(provenance.causationId === null ? {} : { causationId: provenance.causationId }),
    recordedAt: provenance.recordedAt,
  };
}

function serializeRecord(record: ContentRightsRecord): Record<string, unknown> {
  return {
    rightsRecordId: record.rightsRecordId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    contentAssetRef: record.contentAssetRef,
    assetKind: record.assetKind,
    state: record.state,
    sourceEvidenceRef: record.sourceEvidenceRef,
    ...(record.licenceLabel === null ? {} : { licenceLabel: record.licenceLabel }),
    ...(record.licenceEvidenceRef === null
      ? {}
      : { licenceEvidenceRef: record.licenceEvidenceRef }),
    ...(record.validUntil === null ? {} : { validUntil: record.validUntil }),
    provenance: serializeProvenance(record.provenance),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeEvent(event: ContentRightsEventRecord): Record<string, unknown> {
  return {
    eventId: event.eventId,
    rightsRecordId: event.rightsRecordId,
    fromState: event.fromState,
    toState: event.toState,
    eventKind: event.eventKind,
    reason: event.reason,
    ...(event.clearanceId === null ? {} : { clearanceId: event.clearanceId }),
    provenance: serializeProvenance(event.provenance),
  };
}

function serializeClearance(clearance: ContentRightsClearanceRecord): Record<string, unknown> {
  return {
    clearanceId: clearance.clearanceId,
    rightsRecordId: clearance.rightsRecordId,
    clearedByActor: clearance.clearedByActor,
    clearedVia: clearance.clearedVia,
    rationale: clearance.rationale,
    ...(clearance.evidenceRef === null ? {} : { evidenceRef: clearance.evidenceRef }),
    clearedAt: clearance.clearedAt,
  };
}

function serializePermission(permission: ContentRightsPermissionRecord): Record<string, unknown> {
  return {
    permissionId: permission.permissionId,
    rightsRecordId: permission.rightsRecordId,
    platformKey: permission.platformKey,
    permission: permission.permission,
    evidenceRef: permission.evidenceRef,
    provenance: serializeProvenance(permission.provenance),
  };
}

function serializeLineage(link: ContentRightsLineageRecord): Record<string, unknown> {
  return {
    lineageLinkId: link.lineageLinkId,
    agencyId: link.agencyId,
    clientId: link.clientId,
    ...(link.workspaceId === null ? {} : { workspaceId: link.workspaceId }),
    compositeAssetRef: link.compositeAssetRef,
    ingredientAssetRef: link.ingredientAssetRef,
    provenance: serializeProvenance(link.provenance),
  };
}

function serializeGateResult(result: ContentRightsGateResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    reasons: result.reasons.map((reason) => ({
      code: reason.code,
      detail: reason.detail,
    })),
    assetRef: result.assetRef,
    destinationPlatform: result.destinationPlatform,
    composite: result.composite,
    ingredientEvaluations: result.ingredientEvaluations.map((ingredient) => ({
      assetRef: ingredient.assetRef,
      outcome: ingredient.outcome,
      reasonCodes: [...ingredient.reasonCodes],
    })),
    policyDecisionId: result.policyDecisionId,
    evaluatedAt: result.evaluatedAt,
    vocabularyVersion: result.vocabularyVersion,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** The validated register DTO (the strict-validation output type). */
type ValidatedRegisterBody = {
  readonly contentAssetRef: string;
  readonly assetKind: string;
  readonly sourceEvidenceRef: string;
  readonly licenceLabel: string | undefined;
  readonly licenceEvidenceRef: string | undefined;
  readonly validUntil: string | undefined;
  readonly workspaceId: string | undefined;
};

/** The validated transition DTO. */
type ValidatedTransitionBody = {
  readonly eventKind: string;
  readonly toState: string;
  readonly reason: string;
  readonly rationale: string | undefined;
  readonly evidenceRef: string | undefined;
};

/** The validated permission DTO. */
type ValidatedPermissionBody = {
  readonly platformKey: string;
  readonly permission: string;
  readonly evidenceRef: string;
};

/** The validated lineage DTO. */
type ValidatedLineageBody = {
  readonly compositeAssetRef: string;
  readonly ingredientAssetRef: string;
  readonly workspaceId: string | undefined;
};

/** The validated gate DTO. */
type ValidatedGateBody = {
  readonly assetRef: string;
  readonly destinationPlatform: string;
};

export function registerContentRightsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('content-rights.api');

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
   * The canonical RIGHTS-RECORD owner resolution for every
   * record-scoped route: the module resolves the record + its owning
   * chain; a record that does not exist, or that belongs to ANOTHER
   * Client than the path's, is the SAME uniform 404 (a foreign
   * identifier is not a traversal oracle). Malformed ids are the same
   * uniform 404 (the module's UUID guard).
   */
  async function requireRightsRecordInClient(rightsRecordId: string, clientId: string) {
    if (!UUID_PATTERN.test(rightsRecordId)) {
      throw new NotFoundError('content_rights_record', rightsRecordId);
    }
    const ownership = await modules.contentRights.resolveRightsOwnership(rightsRecordId);
    if (ownership === null || ownership.record.clientId !== clientId) {
      throw new NotFoundError('content_rights_record', rightsRecordId);
    }
    return ownership;
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-rights — register the rights
  // record for one content-asset reference (born 'unknown'; source
  // provenance REQUIRED; the licence facts recorded up front so a later
  // licence-basis determination has its immutable evidence in place).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-rights',
    defineMutationRoute<{ clientId: string }, ContentRightsRecord>({
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
          forbiddenKeys: CONTENT_RIGHTS_AUTHORITY_FIELDS,
          fields: {
            contentAssetRef: stringField({ pattern: ASSET_REF_PATTERN }),
            assetKind: stringField({ pattern: ASSET_KIND_PATTERN }),
            sourceEvidenceRef: stringField({ pattern: UUID_PATTERN }),
            licenceLabel: optionalString({ minLength: 1, maxLength: 500 }),
            licenceEvidenceRef: optionalString({ pattern: UUID_PATTERN }),
            validUntil: optionalString({ pattern: ISO_TIMESTAMP_PATTERN }),
            // The OPTIONAL workspace narrowing — validated against the
            // client's workspaces by the module's DB tenant fence, but
            // resolved canonically here first (uniform 404 on foreign).
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedRegisterBody;
        if (body.workspaceId !== undefined) {
          await requireWorkspaceAccess(modules, ctx.principal, body.workspaceId);
        }
        // The server-derived tenant scope (the /clients chain — never a
        // request field; the path only SELECTS which durable client
        // gets resolved).
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        return modules.contentRights.registerContentRights(
          {
            agencyId: ownership.client.agencyId,
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            contentAssetRef: body.contentAssetRef,
            assetKind: body.assetKind as 'source' | 'composite',
            sourceEvidenceRef: body.sourceEvidenceRef,
            licenceLabel: body.licenceLabel ?? null,
            licenceEvidenceRef: body.licenceEvidenceRef ?? null,
            validUntil: body.validUntil ?? null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_rights.registered', undefined, {
          rights_record_id: ctx.result.rightsRecordId,
          client_id: ctx.params.clientId,
          content_asset_ref: ctx.result.contentAssetRef,
          asset_kind: ctx.result.assetKind,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_rights.registered',
          targetType: 'content_rights_record',
          targetId: ctx.result.rightsRecordId,
          afterVersion: ctx.result.version,
          idempotencyKey: `content_rights.registered:${ctx.result.rightsRecordId}`,
          details: {
            contentAssetRef: ctx.result.contentAssetRef,
            assetKind: ctx.result.assetKind,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          record: serializeRecord(ctx.result),
          vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-rights — the client's rights
  // records, newest first (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-rights',
    defineQueryRoute<{ clientId: string }, readonly ContentRightsRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.contentRights.listRightsRecordsForClient(ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          records: ctx.result.map(serializeRecord),
          vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-rights/by-asset/:assetRef — the
  // record for ONE asset reference (any active member; 404 when none
  // exists — the gate's absent-evaluation case reads here honestly).
  // Registered BEFORE the :rightsRecordId patterns (first-match-wins).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-rights/by-asset/:assetRef',
    defineQueryRoute<{ clientId: string; assetRef: string }, ContentRightsRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        if (!ASSET_REF_PATTERN.test(ctx.params.assetRef)) {
          throw new NotFoundError('content_asset_ref', ctx.params.assetRef);
        }
        const record = await modules.contentRights.getRightsRecordForAsset(
          ctx.params.clientId,
          ctx.params.assetRef,
        );
        if (record === null) {
          throw new NotFoundError('content_asset_ref', ctx.params.assetRef);
        }
        return record;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          record: serializeRecord(ctx.result),
          vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-rights/gate — THE PUBLICATION
  // GATE (any active member): evaluates whether the asset's rights
  // permit autonomous publication to ONE destination platform — allow /
  // review_required / blocked WITH reasons, the per-ingredient
  // breakdown and the destination-policy decision id. This is an
  // EVALUATION, never a publication (boundary rule 4: no publish/
  // dispatch verb exists anywhere in this family).
  // Registered BEFORE the :rightsRecordId patterns (first-match-wins).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-rights/gate',
    defineMutationRoute<{ clientId: string }, ContentRightsGateResult>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<ValidatedGateBody>(ctx.request.body, {
          forbiddenKeys: CONTENT_RIGHTS_AUTHORITY_FIELDS,
          fields: {
            assetRef: stringField({ pattern: ASSET_REF_PATTERN }),
            destinationPlatform: stringField({ pattern: PLATFORM_KEY_PATTERN_SRC }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedGateBody;
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        return modules.contentRights.evaluatePublicationGate(
          {
            agencyId: ownership.client.agencyId,
            clientId: ctx.params.clientId,
            assetRef: body.assetRef,
            destinationPlatform: body.destinationPlatform,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_rights.gate_evaluated', undefined, {
          client_id: ctx.params.clientId,
          asset_ref: ctx.result.assetRef,
          destination_platform: ctx.result.destinationPlatform,
          outcome: ctx.result.outcome,
          policy_decision_id: ctx.result.policyDecisionId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_rights.gate_evaluated',
          targetType: 'content_rights_gate',
          targetId: `${ctx.result.assetRef}:${ctx.result.destinationPlatform}`,
          idempotencyKey: null,
          details: {
            outcome: ctx.result.outcome,
            reasonCodes: ctx.result.reasons.map((reason) => reason.code).join(','),
            policyDecisionId: ctx.result.policyDecisionId,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          gate: serializeGateResult(ctx.result),
          vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-rights/lineage — record ONE
  // immutable ingredient lineage link (the composition fact MKT-064
  // will call when it derives composite assets).
  // Registered BEFORE the :rightsRecordId patterns (first-match-wins).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-rights/lineage',
    defineMutationRoute<{ clientId: string }, ContentRightsLineageRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedLineageBody>(ctx.request.body, {
          forbiddenKeys: CONTENT_RIGHTS_AUTHORITY_FIELDS,
          fields: {
            compositeAssetRef: stringField({ pattern: ASSET_REF_PATTERN }),
            ingredientAssetRef: stringField({ pattern: ASSET_REF_PATTERN }),
            // The OPTIONAL workspace narrowing (validated selection
            // input — the register precedent).
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedLineageBody;
        if (body.workspaceId !== undefined) {
          await requireWorkspaceAccess(modules, ctx.principal, body.workspaceId);
        }
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        return modules.contentRights.recordLineageLink(
          {
            agencyId: ownership.client.agencyId,
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            compositeAssetRef: body.compositeAssetRef,
            ingredientAssetRef: body.ingredientAssetRef,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_rights.lineage_linked', undefined, {
          lineage_link_id: ctx.result.lineageLinkId,
          client_id: ctx.params.clientId,
          composite_asset_ref: ctx.result.compositeAssetRef,
          ingredient_asset_ref: ctx.result.ingredientAssetRef,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_rights.lineage_linked',
          targetType: 'content_rights_lineage_link',
          targetId: ctx.result.lineageLinkId,
          idempotencyKey: `content_rights.lineage_linked:${ctx.result.lineageLinkId}`,
          details: {
            compositeAssetRef: ctx.result.compositeAssetRef,
            ingredientAssetRef: ctx.result.ingredientAssetRef,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          lineageLink: serializeLineage(ctx.result),
          vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-rights/lineage/:compositeAssetRef
  // — the composite's lineage links (any active member).
  // Registered BEFORE the :rightsRecordId patterns (first-match-wins).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-rights/lineage/:compositeAssetRef',
    defineQueryRoute<
      { clientId: string; compositeAssetRef: string },
      readonly ContentRightsLineageRecord[]
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        if (!ASSET_REF_PATTERN.test(ctx.params.compositeAssetRef)) {
          throw new NotFoundError('content_asset_ref', ctx.params.compositeAssetRef);
        }
        return modules.contentRights.listLineageLinks(
          ctx.params.clientId,
          ctx.params.compositeAssetRef,
        );
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          compositeAssetRef: ctx.params.compositeAssetRef,
          lineageLinks: ctx.result.map(serializeLineage),
          vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-rights/:rightsRecordId — one
  // record + its FULL append-only tails: the transition-event history,
  // the permission-scope tail and the clearance history (any active
  // member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-rights/:rightsRecordId',
    defineQueryRoute<
      { clientId: string; rightsRecordId: string },
      {
        record: ContentRightsRecord;
        events: readonly ContentRightsEventRecord[];
        permissions: readonly ContentRightsPermissionRecord[];
        clearances: readonly ContentRightsClearanceRecord[];
      }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        await requireRightsRecordInClient(ctx.params.rightsRecordId, ctx.params.clientId);
        const record = await modules.contentRights.getRightsRecord(ctx.params.rightsRecordId);
        if (record === null) {
          throw new NotFoundError('content_rights_record', ctx.params.rightsRecordId);
        }
        const events = await modules.contentRights.listRightsEvents(ctx.params.rightsRecordId);
        const permissions = await modules.contentRights.listPlatformPermissions(
          ctx.params.rightsRecordId,
        );
        const clearances = await modules.contentRights.listClearances(ctx.params.rightsRecordId);
        return {
          record,
          events: events ?? [],
          permissions: permissions ?? [],
          clearances: clearances ?? [],
        };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          record: serializeRecord(ctx.result.record),
          events: ctx.result.events.map(serializeEvent),
          permissions: ctx.result.permissions.map(serializePermission),
          clearances: ctx.result.clearances.map(serializeClearance),
          vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-rights/:rightsRecordId/transitions
  // — record ONE state transition (owner|admin). The human_clearance
  // kind IS the ONLY review → cleared path: it requires the clearance
  // rationale and records the clearing actor (the authenticated human
  // principal). Fair-use reasoning rides as the clearance's evidenceRef
  // — evidence for review, never an auto-clear.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-rights/:rightsRecordId/transitions',
    defineMutationRoute<
      { clientId: string; rightsRecordId: string },
      {
        record: ContentRightsRecord;
        event: ContentRightsEventRecord;
        clearance: ContentRightsClearanceRecord | null;
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
        validateObject<ValidatedTransitionBody>(ctx.request.body, {
          forbiddenKeys: CONTENT_RIGHTS_AUTHORITY_FIELDS,
          fields: {
            eventKind: stringField({ pattern: EVENT_KIND_PATTERN }),
            toState: stringField({ pattern: STATE_PATTERN }),
            reason: stringField({ minLength: 1, maxLength: 2000 }),
            // The human_clearance payload (REQUIRED for that kind — the
            // module enforces; validated bounded here).
            rationale: optionalString({ minLength: 1, maxLength: 4000 }),
            evidenceRef: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedTransitionBody;
        await requireRightsRecordInClient(ctx.params.rightsRecordId, ctx.params.clientId);
        return modules.contentRights.recordRightsTransition(
          {
            rightsRecordId: ctx.params.rightsRecordId,
            eventKind: body.eventKind as
              | 'determination'
              | 'human_clearance'
              | 'contestation'
              | 'revocation'
              | 'review_denial'
              | 're_review_request',
            toState: body.toState as
              | 'owned'
              | 'license'
              | 'platform_permitted'
              | 'cleared'
              | 'review'
              | 'blocked'
              | 'unknown',
            reason: body.reason,
            clearance:
              body.eventKind === 'human_clearance'
                ? {
                    rationale: body.rationale ?? '',
                    evidenceRef: body.evidenceRef ?? null,
                  }
                : null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_rights.transitioned', undefined, {
          rights_record_id: ctx.params.rightsRecordId,
          client_id: ctx.params.clientId,
          event_kind: ctx.result.event.eventKind,
          from_state: ctx.result.event.fromState,
          to_state: ctx.result.event.toState,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_rights.transitioned',
          targetType: 'content_rights_record',
          targetId: ctx.params.rightsRecordId,
          afterVersion: ctx.result.record.version,
          idempotencyKey: `content_rights.transitioned:${ctx.result.event.eventId}`,
          details: {
            eventKind: ctx.result.event.eventKind,
            fromState: ctx.result.event.fromState,
            toState: ctx.result.event.toState,
            ...(ctx.result.clearance === null
              ? {}
              : { clearanceId: ctx.result.clearance.clearanceId }),
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          record: serializeRecord(ctx.result.record),
          event: serializeEvent(ctx.result.event),
          ...(ctx.result.clearance === null
            ? {}
            : { clearance: serializeClearance(ctx.result.clearance) }),
          vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-rights/:rightsRecordId/permissions
  // — append ONE destination-platform permission-scope row (owner|
  // admin; the newest row per platform is the effective permission).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-rights/:rightsRecordId/permissions',
    defineMutationRoute<
      { clientId: string; rightsRecordId: string },
      ContentRightsPermissionRecord
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
        validateObject<ValidatedPermissionBody>(ctx.request.body, {
          forbiddenKeys: CONTENT_RIGHTS_AUTHORITY_FIELDS,
          fields: {
            platformKey: stringField({ pattern: PLATFORM_KEY_PATTERN_SRC }),
            permission: stringField({ pattern: PERMISSION_PATTERN }),
            evidenceRef: stringField({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedPermissionBody;
        await requireRightsRecordInClient(ctx.params.rightsRecordId, ctx.params.clientId);
        return modules.contentRights.recordPlatformPermission(
          {
            rightsRecordId: ctx.params.rightsRecordId,
            platformKey: body.platformKey,
            permission: body.permission as 'permitted' | 'not_permitted',
            evidenceRef: body.evidenceRef,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('content_rights.permission_recorded', undefined, {
          rights_record_id: ctx.params.rightsRecordId,
          client_id: ctx.params.clientId,
          platform_key: ctx.result.platformKey,
          permission: ctx.result.permission,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'content_rights.permission_recorded',
          targetType: 'content_rights_permission',
          targetId: ctx.result.permissionId,
          idempotencyKey: `content_rights.permission_recorded:${ctx.result.permissionId}`,
          details: {
            rightsRecordId: ctx.result.rightsRecordId,
            platformKey: ctx.result.platformKey,
            permission: ctx.result.permission,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          permission: serializePermission(ctx.result),
          vocabularyVersion: CONTENT_RIGHTS_VOCABULARY_VERSION,
        }),
    }),
  );
}
