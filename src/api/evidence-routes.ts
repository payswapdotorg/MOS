/**
 * /evidence API routes (MKT-013, EVID-001).
 *
 *   POST   /api/clients/:clientId/evidence            append evidence (any active member)
 *   GET    /api/clients/:clientId/evidence            list the Client's evidence ledger (any active member)
 *   GET    /api/evidence/:evidenceId                  read one record, superseded included (member of the OWNING agency)
 *   POST   /api/evidence/:evidenceId/supersede        explicit correction — a NEW record replacing the prior (owner|admin|platform admin)
 *
 * There is deliberately NO update and NO delete route: evidence is
 * append-oriented and immutable (EVID-AC-02), corrections are the explicit
 * supersede command above, and claims are never auto-promoted to
 * authoritative classes (EVID-AC-03 — the module + DB tier guards reject
 * claim→authoritative supersession with a 422).
 *
 * PROVENANCE IS SERVER-DERIVED on every append: actor from the
 * authenticated principal, correlation from the ambient correlation
 * context, recording system ('api') and recordedAt from the module clock.
 * The request DTOs reject every provenance-shaped authority field — a
 * caller can never supply actor, source-of-record, correlation or
 * timestamps (implementation-contract §3). The caller-declared confidence
 * score is claim metadata only; it never touches provenance, class or tier.
 *
 * Authorization follows the established hard-boundary posture: the owning
 * Client is resolved from durable state BEFORE authorize (uniform 404 for
 * unknown/foreign identifiers — no cross-tenant oracle), and every
 * evidence-scoped route resolves the canonical owner chain
 * evidence → client → agency before any dependent traversal.
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
  optionalNumber,
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import { requireClientAccess, requireEvidenceAccess } from './authorize.ts';
import type { EvidenceRecord } from '../modules/evidence/public.ts';

const EVIDENCE_CLASS_PATTERN =
  /^(source_fact|observation|inference|hypothesis|attribution|prediction|causal_estimate|learning)$/;
const EVIDENCE_QUALITY_PATTERN = /^[A-F]$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Fields that are always server-derived on append — plus every
 * material-shaped key is rejected so nothing secret can even be smuggled
 * into the top level of an evidence payload (§21 defense in depth beyond
 * the module's content guard).
 */
const EVIDENCE_CREATE_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/bookkeeping.
  'evidenceId',
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
  // Supersession is ONLY reachable through the explicit supersede command.
  'supersedes',
  'supersedesBy',
  'supersedesEvidenceId',
  'supersededBy',
  // Material-shaped keys are rejected outright on the evidence surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'accessKey',
] as const;

/**
 * The supersede body carries the NEW record's content only: the prior
 * identity comes from the PATH and the Workspace scope is INHERITED from
 * the prior record (a correction never moves scope).
 */
const EVIDENCE_SUPERSEDE_AUTHORITY_FIELDS = [
  ...EVIDENCE_CREATE_AUTHORITY_FIELDS,
  'workspaceId',
] as const;

/**
 * SERVER-DERIVED provenance for HTTP appends: actor from the authenticated
 * principal, correlation from the ambient correlation context, recording
 * system 'api'. No value in here is reachable from the request body (the
 * DTO rejects every provenance-shaped key).
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

/** Shared content spec for append and supersede bodies. */
function evidenceContentSpec() {
  return {
    class: stringField({ pattern: EVIDENCE_CLASS_PATTERN }),
    sourceSystem: stringField({ minLength: 1, maxLength: 100 }),
    sourceRef: optionalString({ minLength: 1, maxLength: 512 }),
    observedAt: stringField({ pattern: ISO_TIMESTAMP_PATTERN }),
    content: recordField({ maxDepthKeys: 100 }),
    contentRef: optionalString({ minLength: 1, maxLength: 512 }),
    quality: stringField({ pattern: EVIDENCE_QUALITY_PATTERN }),
    confidence: optionalNumber({ min: 0, max: 1 }),
  } as const;
}

type ValidatedEvidenceContent = {
  readonly class: string;
  readonly sourceSystem: string;
  readonly sourceRef: string | undefined;
  readonly observedAt: string;
  readonly content: Record<string, unknown>;
  readonly contentRef: string | undefined;
  readonly quality: string;
  readonly confidence: number | undefined;
};

function serializeEvidence(record: EvidenceRecord): Record<string, unknown> {
  return {
    evidenceId: record.evidenceId,
    clientId: record.clientId,
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    class: record.class,
    source: {
      system: record.source.system,
      ...(record.source.ref === null ? {} : { ref: record.source.ref }),
    },
    observedAt: record.observedAt,
    content: record.content,
    ...(record.contentRef === null ? {} : { contentRef: record.contentRef }),
    quality: record.quality,
    ...(record.confidence === null ? {} : { confidence: record.confidence }),
    ...(record.supersedes === null ? {} : { supersedes: record.supersedes }),
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

export function registerEvidenceRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('evidence.api');

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

  /**
   * Canonical Evidence owner scope: the evidence row → its Client (through
   * /clients) → the owning Agency (plus the scoped Workspace row), resolved
   * from durable state before authorize/validate/execute. Unknown,
   * deleted-client and (for the caller) foreign identifiers all surface as
   * the same 404 here or in authorize — never as a traversal.
   */
  async function evidenceOwner(evidenceId: string): Promise<OwnerScope> {
    const ownership = await modules.evidence.resolveEvidenceOwnership(evidenceId);
    if (ownership === null) {
      throw new NotFoundError('evidence', evidenceId);
    }
    return {
      kind: 'evidence',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
      evidenceId: ownership.scope.evidenceId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/evidence — APPEND one immutable evidence
  // record (the only creation path; supersession is NOT reachable here —
  // every supersedes-shaped authority field is rejected). Client ownership
  // comes from the PATH and is resolved canonically BEFORE authorization;
  // the optional workspaceId is scope INPUT validated against canonical
  // workspace ownership inside the module — never an authorization.
  // Identity, provenance and timestamps are server-derived.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/evidence',
    defineMutationRoute<{ clientId: string }, EvidenceRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<ValidatedEvidenceContent & { workspaceId: string | undefined }>(
          ctx.request.body,
          {
            forbiddenKeys: EVIDENCE_CREATE_AUTHORITY_FIELDS,
            fields: {
              ...evidenceContentSpec(),
              workspaceId: optionalString({ minLength: 36, maxLength: 36 }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedEvidenceContent & {
          workspaceId: string | undefined;
        };
        return modules.evidence.appendEvidence(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId === undefined ? null : body.workspaceId,
            class: body.class as EvidenceRecord['class'],
            source: {
              system: body.sourceSystem,
              ref: body.sourceRef === undefined ? null : body.sourceRef,
            },
            observedAt: body.observedAt,
            content: body.content,
            contentRef: body.contentRef === undefined ? null : body.contentRef,
            quality: body.quality as EvidenceRecord['quality'],
            confidence: body.confidence === undefined ? null : body.confidence,
            supersedesEvidenceId: null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('evidence.record.appended', undefined, {
          evidence_id: ctx.result.evidenceId,
          client_id: ctx.result.clientId,
          workspace_id: ctx.result.workspaceId,
          class: ctx.result.class,
          quality: ctx.result.quality,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'evidence.record.appended',
          targetType: 'evidence',
          targetId: ctx.result.evidenceId,
          idempotencyKey: `evidence.record.appended:${ctx.result.evidenceId}`,
          details: {
            class: ctx.result.class,
            quality: ctx.result.quality,
            sourceSystem: ctx.result.source.system,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeEvidence(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/evidence — the Client's append-only evidence
  // ledger, newest first (superseded records included: immutable history
  // stays readable; each record carries supersededBy when replaced).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/evidence',
    defineQueryRoute<{ clientId: string }, readonly EvidenceRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.evidence.listEvidenceForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          evidence: ctx.result.map(serializeEvidence),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/evidence/:evidenceId — read one record. Cross-tenant/unknown/
  // deleted-client → uniform 404. Superseded records are readable history.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/evidence/:evidenceId',
    defineQueryRoute<{ evidenceId: string }, EvidenceRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireEvidenceAccess(modules, ctx.principal, ctx.params.evidenceId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.evidence.resolveEvidenceOwnership(ctx.params.evidenceId);
        if (ownership === null) {
          throw new NotFoundError('evidence', ctx.params.evidenceId);
        }
        return ownership.evidence;
      },
      respond: (ctx) => jsonResponse(200, serializeEvidence(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/evidence/:evidenceId/supersede — the EXPLICIT correction
  // command: appends a NEW immutable record that references the prior record
  // (supersedes) and takes its place (the prior gains supersededBy). The
  // prior record is NEVER modified. Same-Client only; same authority TIER
  // only (a claim can never be superseded into source_fact/observation —
  // EVID-AC-03, 422). At most ONE superseding record per prior record
  // (409 on a repeat or a lost race). The Workspace scope is INHERITED from
  // the prior record (corrections never move scope). Requires
  // owner|admin|platform admin — supersession is an explicit authorized
  // correction, not a casual mutation.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/evidence/:evidenceId/supersede',
    defineMutationRoute<{ evidenceId: string }, EvidenceRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => evidenceOwner(params.evidenceId),
      authorize: async (ctx) => {
        await requireEvidenceAccess(modules, ctx.principal, ctx.params.evidenceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedEvidenceContent>(ctx.request.body, {
          forbiddenKeys: EVIDENCE_SUPERSEDE_AUTHORITY_FIELDS,
          fields: evidenceContentSpec(),
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedEvidenceContent;
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.evidence.resolveEvidenceOwnership(ctx.params.evidenceId);
        if (ownership === null) {
          throw new NotFoundError('evidence', ctx.params.evidenceId);
        }
        const prior = ownership.evidence;
        return modules.evidence.appendEvidence(
          {
            clientId: prior.clientId,
            // Scope-preserving correction: the Workspace scope is INHERITED
            // from the prior record (the supersede DTO rejects workspaceId).
            workspaceId: prior.workspaceId,
            class: body.class as EvidenceRecord['class'],
            source: {
              system: body.sourceSystem,
              ref: body.sourceRef === undefined ? null : body.sourceRef,
            },
            observedAt: body.observedAt,
            content: body.content,
            contentRef: body.contentRef === undefined ? null : body.contentRef,
            quality: body.quality as EvidenceRecord['quality'],
            confidence: body.confidence === undefined ? null : body.confidence,
            supersedesEvidenceId: prior.evidenceId,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('evidence.record.superseded', undefined, {
          evidence_id: ctx.result.evidenceId,
          supersedes: ctx.result.supersedes,
          client_id: ctx.result.clientId,
          class: ctx.result.class,
          quality: ctx.result.quality,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'evidence.record.superseded',
          targetType: 'evidence',
          targetId: ctx.result.evidenceId,
          idempotencyKey: `evidence.record.superseded:${ctx.result.supersedes ?? 'none'}`,
          details: {
            supersedes: ctx.result.supersedes,
            class: ctx.result.class,
            quality: ctx.result.quality,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeEvidence(ctx.result)),
    }),
  );
}
