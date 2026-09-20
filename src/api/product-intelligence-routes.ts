/**
 * /api/product-contexts/* routes (MKT-069 — Product Intelligence: the
 * durable product/market inspection and model record surface).
 *
 *   POST /api/agencies/:agencyId/product-contexts                            create (owner|admin|platform admin)
 *   GET  /api/agencies/:agencyId/product-contexts                            the agency's contexts (any active member)
 *   GET  /api/product-contexts/:productContextId                             the composed honest read-back (record + current declaration + versions + facts + derived models + risks + runs) (any active member of the owning agency)
 *   GET  /api/product-contexts/:productContextId/versions                    the append-only version tail (any active member)
 *   GET  /api/product-contexts/:productContextId/source-facts                the retained source-fact tail (any active member)
 *   GET  /api/product-contexts/:productContextId/derived-models              the derived model records with evidence links (any active member)
 *   GET  /api/product-contexts/:productContextId/risk-flags                  the risk flags (any active member)
 *   GET  /api/product-contexts/:productContextId/inspection-runs             the inspection runs with per-input outcomes (any active member)
 *   POST /api/product-contexts/:productContextId/versions                    record a NEW declared version — the correction path (owner|admin; CAS)
 *   POST /api/product-contexts/:productContextId/inspections                 run the deterministic inspection (owner|admin)
 *   POST /api/product-contexts/:productContextId/derived-models              record one derived model claim (owner|admin; evidence-linked; AI disclosure)
 *   POST /api/product-contexts/:productContextId/risk-flags                  record one risk flag (owner|admin; append-only)
 *
 * SURFACE DISCIPLINE (the dispatch boundary battery): GET/POST ONLY — no
 * PUT, no PATCH, no DELETE (asserted by
 * tests/architecture/product-intelligence-boundary.test.ts). The declared
 * inputs are never rewritten in place: corrections are NEW version records
 * (POST .../versions). NO mission-strategy/planner verb exists anywhere in
 * this family — MKT-070 (the Product Marketing Mission Planner) is a
 * later Work Item and composes the module read surface by reference; NO
 * mutation toward any external source exists (boundary rule 7 — the
 * inspection POST is the bounded deterministic fetch/extract over already
 * declared inputs; a future write capability is the separately-granted
 * capability-key seam documented in the runbook, deliberately NOT built).
 *
 * Server-derived scope posture (implementation-contract §3/§23; the
 * growth-missions precedent): every surface resolves the caller's
 * authorization context and the canonical scope from durable state BEFORE
 * the module call; the path identifiers only SELECT which durable scope
 * gets resolved (a caller-supplied identifier is never an authorization).
 * Uniform 404 for foreign/unknown/malformed agency/context identifiers
 * (no existence oracle — foreign ≡ unknown ≡ malformed); a suspended
 * membership or disabled identity is the 403; anonymous calls fail closed
 * 401 at the authenticator. Provenance is SERVER-DERIVED from the
 * authenticated principal + the ambient correlation context (never a
 * request field; the DTOs reject every provenance-shaped key).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
} from '../platform/http/pipeline.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  arrayField,
  intField,
  objectField,
  optionalString,
  recordField,
  stringField,
  validateObject,
  type FieldSpec,
  type ObjectSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import { resolveContext } from './authorize.ts';
import type {
  ProductContextDeclarationInput,
  ProductContextDetail,
  ProductContextInputDeclaration,
  ProductContextRecord,
  ProductDerivedModelRecord,
  ProductIntelligenceProvenance,
  ProductInspectionRunRecord,
  ProductRiskFlagRecord,
  ProductSourceFactRecord,
  ProductContextVersionRecord,
} from '../modules/product-intelligence/public.ts';
import {
  PRODUCT_INTELLIGENCE_DERIVATION_KINDS,
  PRODUCT_INTELLIGENCE_INPUT_KINDS,
  PRODUCT_INTELLIGENCE_RISK_CATEGORIES,
  PRODUCT_INTELLIGENCE_RISK_SEVERITIES,
  PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES,
} from '../modules/product-intelligence/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_PATTERN = new RegExp(`^(${PRODUCT_INTELLIGENCE_INPUT_KINDS.join('|')})$`);
const AUTHORIZATION_PATTERN = new RegExp(
  `^(${PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES.join('|')})$`,
);
const DERIVATION_KIND_PATTERN = new RegExp(`^(${PRODUCT_INTELLIGENCE_DERIVATION_KINDS.join('|')})$`);
const CATEGORY_PATTERN = new RegExp(`^(${PRODUCT_INTELLIGENCE_RISK_CATEGORIES.join('|')})$`);
const SEVERITY_PATTERN = new RegExp(`^(${PRODUCT_INTELLIGENCE_RISK_SEVERITIES.join('|')})$`);

/** Fields that are always server-derived (authority fields). */
const CONTEXT_CREATE_AUTHORITY_FIELDS = [
  'productContextId',
  'agencyId',
  'currentVersionSeq',
  'version',
  'createdActor',
  'createdAt',
  'updatedAt',
  'provenance',
] as const;

/** CAS mutations legitimately receive `version`; identity/scope/provenance are rejected. */
const CONTEXT_CAS_AUTHORITY_FIELDS = [
  'productContextId',
  'agencyId',
  'currentVersionSeq',
  'createdActor',
  'createdAt',
  'updatedAt',
  'provenance',
] as const;

const DERIVED_MODEL_AUTHORITY_FIELDS = [
  'derivedModelId',
  'productContextId',
  'verificationState',
  'supersededByDerivedModelId',
  'evidenceResolved',
  'provenance',
] as const;

const RISK_FLAG_AUTHORITY_FIELDS = [
  'riskFlagId',
  'productContextId',
  'provenance',
] as const;

// ---------------------------------------------------------------------------
// Server-derived provenance (never a request field)
// ---------------------------------------------------------------------------

function serverProvenance(principal: Principal): ProductIntelligenceProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Authorization (the growth-missions fail-closed posture)
// ---------------------------------------------------------------------------

/**
 * The agency-scoped posture: the durable agency row and the caller's
 * membership in THAT agency resolve from durable state BEFORE the module
 * call. A malformed, unknown or FOREIGN agency identifier is the uniform
 * 404 (cross-agency data must 404, not 403-leak existence); a caller with
 * an ACTIVE membership passes (optionally restricted to `roles`); a
 * suspended membership or a disabled identity is the 403.
 */
async function requireProductIntelligenceAgency(
  modules: ApplicationModules,
  principal: Principal,
  agencyId: string,
  roles?: ReadonlyArray<string>,
): Promise<void> {
  if (!UUID_PATTERN.test(agencyId)) {
    // A malformed identifier is indistinguishable from an unknown one.
    throw new NotFoundError('agency', agencyId);
  }
  const agency = await modules.agencies.getAgency(agencyId);
  if (agency === null) {
    throw new NotFoundError('agency', agencyId);
  }

  if (principal.kind === 'service') return;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return;

  const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
  if (membership === undefined) {
    // Hard boundary: not a member of the agency → the same 404 as for an
    // unknown agency (uniform, no cross-agency existence oracle).
    throw new NotFoundError('agency', agencyId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in this agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
}

/**
 * The context-scoped posture: the canonical product-context ownership
 * resolves from durable state BEFORE authorization — a malformed or
 * unknown context identifier is the uniform 404; a caller with NO
 * membership in the OWNING agency gets the SAME 404 (a foreign context
 * identifier is not a traversal/existence oracle); a suspended membership
 * is the 403. Returns the owning agency id for the pipeline owner scope.
 */
async function requireProductContextAccess(
  modules: ApplicationModules,
  principal: Principal,
  productContextId: string,
  roles?: ReadonlyArray<string>,
): Promise<string> {
  if (!UUID_PATTERN.test(productContextId)) {
    throw new NotFoundError('product context', productContextId);
  }
  const ownership = await modules.productIntelligence.resolveProductContextOwnership(productContextId);
  if (ownership === null) {
    throw new NotFoundError('product context', productContextId);
  }
  const agencyId = ownership.context.agencyId;

  if (principal.kind === 'service') return agencyId;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return agencyId;

  const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
  if (membership === undefined) {
    // Hard boundary: not a member of the OWNING agency → indistinguishable
    // from an unknown context (uniform 404, no cross-tenant oracle).
    throw new NotFoundError('product context', productContextId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the product context agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return agencyId;
}

// ---------------------------------------------------------------------------
// DTO specs (strict validation — the growth-missions discipline)
// ---------------------------------------------------------------------------

type ValidatedInput = {
  kind: string;
  reference: string;
  authorization: string;
  integrationConnectionId: string | undefined;
};

type ValidatedDeclaration = {
  name: string | undefined;
  summary: string | undefined;
  inputs: ValidatedInput[];
};

function inputSpec() {
  return objectField<ValidatedInput>({
    forbiddenKeys: ['provenance'],
    fields: {
      kind: stringField({ pattern: KIND_PATTERN }),
      reference: stringField({ minLength: 1, maxLength: 2048 }),
      authorization: stringField({ pattern: AUTHORIZATION_PATTERN }),
      integrationConnectionId: optionalString({ pattern: UUID_PATTERN }),
    },
  });
}

/** Optional strict nested-object field (absent passes as undefined — the growth-missions precedent). */
function optionalObjectField<T extends Record<string, unknown>>(
  spec: ObjectSpec<T>,
): FieldSpec<T | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      return objectField(spec).parse(value, problems);
    },
  };
}

function declarationSpec(): ObjectSpec<ValidatedDeclaration> {
  return {
    forbiddenKeys: CONTEXT_CREATE_AUTHORITY_FIELDS,
    fields: {
      name: optionalString({ maxLength: 500 }),
      summary: optionalString({ maxLength: 2000 }),
      inputs: arrayField({ minItems: 1, maxItems: 40, item: inputSpec() }),
    },
  };
}

/** Maps the validated DTO onto the module declaration input. */
function toDeclaration(body: ValidatedDeclaration): ProductContextDeclarationInput {
  return {
    name: body.name ?? null,
    summary: body.summary ?? null,
    inputs: body.inputs.map(
      (input): ProductContextInputDeclaration => ({
        kind: input.kind as ProductContextInputDeclaration['kind'],
        reference: input.reference,
        authorization: input.authorization as ProductContextInputDeclaration['authorization'],
        integrationConnectionId: input.integrationConnectionId ?? null,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Serialization (presentation only; every field of the record ships)
// ---------------------------------------------------------------------------

function serializeProvenance(
  provenance: ProductContextVersionRecord['provenance'],
): Record<string, unknown> {
  return {
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
    recordedAt: provenance.recordedAt,
  };
}

function serializeContext(context: ProductContextRecord): Record<string, unknown> {
  return {
    productContextId: context.productContextId,
    agencyId: context.agencyId,
    currentVersionSeq: context.currentVersionSeq,
    version: context.version,
    createdActor: context.createdActor,
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
  };
}

function serializeInput(input: ProductContextVersionRecord['inputs'][number]): Record<string, unknown> {
  return {
    inputId: input.inputId,
    kind: input.kind,
    reference: input.reference,
    authorization: input.authorization,
    integrationConnectionId: input.integrationConnectionId,
    position: input.position,
  };
}

function serializeVersion(version: ProductContextVersionRecord): Record<string, unknown> {
  return {
    productContextVersionId: version.productContextVersionId,
    productContextId: version.productContextId,
    versionSeq: version.versionSeq,
    name: version.name,
    summary: version.summary,
    inputs: version.inputs.map(serializeInput),
    provenance: serializeProvenance(version.provenance),
  };
}

function serializeSourceFact(fact: ProductSourceFactRecord): Record<string, unknown> {
  return {
    sourceFactId: fact.sourceFactId,
    productContextId: fact.productContextId,
    inputId: fact.inputId,
    inspectionRunId: fact.inspectionRunId,
    factKind: fact.factKind,
    sourceRef: fact.sourceRef,
    fetchedAt: fact.fetchedAt,
    extractor: fact.extractor,
    contentHash: fact.contentHash,
    extractionNotes: fact.extractionNotes,
    content: fact.content,
    provenance: serializeProvenance(fact.provenance),
  };
}

function serializeDerivedModel(model: ProductDerivedModelRecord): Record<string, unknown> {
  return {
    derivedModelId: model.derivedModelId,
    productContextId: model.productContextId,
    derivationKind: model.derivationKind,
    statement: model.statement,
    verificationState: model.verificationState,
    supersedesDerivedModelId: model.supersedesDerivedModelId,
    supersededByDerivedModelId: model.supersededByDerivedModelId,
    aiAssistance: model.aiAssistance,
    evidenceSourceFactIds: model.evidenceSourceFactIds,
    provenance: serializeProvenance(model.provenance),
  };
}

function serializeRiskFlag(flag: ProductRiskFlagRecord): Record<string, unknown> {
  return {
    riskFlagId: flag.riskFlagId,
    productContextId: flag.productContextId,
    category: flag.category,
    severity: flag.severity,
    statement: flag.statement,
    mitigation: flag.mitigation,
    evidenceSourceFactIds: flag.evidenceSourceFactIds,
    provenance: serializeProvenance(flag.provenance),
  };
}

function serializeInspectionRun(run: ProductInspectionRunRecord): Record<string, unknown> {
  return {
    inspectionRunId: run.inspectionRunId,
    productContextId: run.productContextId,
    productContextVersionId: run.productContextVersionId,
    status: run.status,
    inputsInspected: run.inputsInspected,
    factsRetained: run.factsRetained,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    inputOutcomes: run.inputOutcomes.map((outcome) => ({
      inspectionInputRunId: outcome.inspectionInputRunId,
      inputId: outcome.inputId,
      outcome: outcome.outcome,
      detail: outcome.detail,
      factsExtracted: outcome.factsExtracted,
    })),
    provenance: serializeProvenance(run.provenance),
  };
}

function serializeDetail(detail: ProductContextDetail): Record<string, unknown> {
  return {
    context: serializeContext(detail.context),
    currentVersion: serializeVersion(detail.currentVersion),
    versions: detail.versions.map(serializeVersion),
    sourceFacts: detail.sourceFacts.map(serializeSourceFact),
    derivedModels: detail.derivedModels.map(serializeDerivedModel),
    riskFlags: detail.riskFlags.map(serializeRiskFlag),
    inspectionRuns: detail.inspectionRuns.map(serializeInspectionRun),
    derivedRecordTier: detail.derivedRecordTier,
    vocabularyVersion: detail.vocabularyVersion,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProductIntelligenceRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('productintelligence.api');

  // -------------------------------------------------------------------------
  // POST /api/agencies/:agencyId/product-contexts — create an agency-scoped
  // Product Context (version 1 of the declared inputs). Agency ownership
  // comes from the PATH and resolves canonically BEFORE authorization;
  // context identity, provenance and timestamps are server-derived; the
  // caller declares the bounded name/summary and the inputs (each with its
  // kind + reference + authorization state) only.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/agencies/:agencyId/product-contexts',
    defineMutationRoute<{ agencyId: string }, ProductContextDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.agencyId)) {
          throw new NotFoundError('agency', params.agencyId);
        }
        const agency = await modules.agencies.getAgency(params.agencyId);
        if (agency === null) {
          throw new NotFoundError('agency', params.agencyId);
        }
        return { kind: 'agency', agencyId: params.agencyId };
      },
      authorize: async (ctx) => {
        await requireProductIntelligenceAgency(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => validateObject<ValidatedDeclaration>(ctx.request.body, declarationSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration;
        return modules.productIntelligence.createProductContext(
          {
            agencyId: ctx.params.agencyId,
            declaration: toDeclaration(body),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('productintelligence.context.created', undefined, {
          product_context_id: ctx.result.context.productContextId,
          agency_id: ctx.params.agencyId,
          inputs: ctx.result.currentVersion.inputs.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.context.created',
          targetType: 'product_context',
          targetId: ctx.result.context.productContextId,
          afterVersion: ctx.result.context.version,
          idempotencyKey: `productintelligence.context.created:${ctx.result.context.productContextId}`,
          details: {
            inputs: ctx.result.currentVersion.inputs.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/agencies/:agencyId/product-contexts — the agency's product
  // contexts (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/agencies/:agencyId/product-contexts',
    defineQueryRoute<{ agencyId: string }, readonly ProductContextRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductIntelligenceAgency(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.productIntelligence.listProductContextsForAgency(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          contexts: ctx.result.map(serializeContext),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:productContextId — the composed honest
  // read-back (the MISSION ATTACHMENT SEAM read surface for MKT-070):
  // record + current declaration + version tail + source facts + derived
  // models + risk flags + inspection runs + the claim-tier disclosure.
  // Foreign/unknown → uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:productContextId',
    defineQueryRoute<{ productContextId: string }, ProductContextDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId);
      },
      execute: async (ctx) => {
        const detail = await modules.productIntelligence.getProductContextDetail(
          ctx.params.productContextId,
        );
        if (detail === null) {
          throw new NotFoundError('product context', ctx.params.productContextId);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:productContextId/versions — the append-only
  // declared-input version tail (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:productContextId/versions',
    defineQueryRoute<{ productContextId: string }, readonly ProductContextVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId);
      },
      execute: async (ctx) => {
        const versions = await modules.productIntelligence.getProductContextVersions(
          ctx.params.productContextId,
        );
        if (versions === null) {
          throw new NotFoundError('product context', ctx.params.productContextId);
        }
        return versions;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          productContextId: ctx.params.productContextId,
          versions: ctx.result.map(serializeVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:productContextId/source-facts — the
  // retained source-fact tail (oldest first; every fact with FULL
  // provenance: source ref, fetched-at, extractor, content hash, notes).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:productContextId/source-facts',
    defineQueryRoute<{ productContextId: string }, readonly ProductSourceFactRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId);
      },
      execute: async (ctx) => {
        const facts = await modules.productIntelligence.getProductContextSourceFacts(
          ctx.params.productContextId,
        );
        if (facts === null) {
          throw new NotFoundError('product context', ctx.params.productContextId);
        }
        return facts;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          productContextId: ctx.params.productContextId,
          sourceFacts: ctx.result.map(serializeSourceFact),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:productContextId/derived-models — the
  // derived model records with their evidence links + AI disclosure
  // (oldest first; superseded history stays readable).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:productContextId/derived-models',
    defineQueryRoute<{ productContextId: string }, readonly ProductDerivedModelRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId);
      },
      execute: async (ctx) => {
        const models = await modules.productIntelligence.getProductContextDerivedModels(
          ctx.params.productContextId,
        );
        if (models === null) {
          throw new NotFoundError('product context', ctx.params.productContextId);
        }
        return models;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          productContextId: ctx.params.productContextId,
          derivedModels: ctx.result.map(serializeDerivedModel),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:productContextId/risk-flags — the risk
  // flags (oldest first; append-only history).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:productContextId/risk-flags',
    defineQueryRoute<{ productContextId: string }, readonly ProductRiskFlagRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId);
      },
      execute: async (ctx) => {
        const flags = await modules.productIntelligence.getProductContextRiskFlags(
          ctx.params.productContextId,
        );
        if (flags === null) {
          throw new NotFoundError('product context', ctx.params.productContextId);
        }
        return flags;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          productContextId: ctx.params.productContextId,
          riskFlags: ctx.result.map(serializeRiskFlag),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:productContextId/inspection-runs — the
  // inspection runs with their per-input honest outcomes (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:productContextId/inspection-runs',
    defineQueryRoute<{ productContextId: string }, readonly ProductInspectionRunRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId);
      },
      execute: async (ctx) => {
        const runs = await modules.productIntelligence.getProductContextInspectionRuns(
          ctx.params.productContextId,
        );
        if (runs === null) {
          throw new NotFoundError('product context', ctx.params.productContextId);
        }
        return runs;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          productContextId: ctx.params.productContextId,
          inspectionRuns: ctx.result.map(serializeInspectionRun),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/product-contexts/:productContextId/versions — the declared
  // input CORRECTION path: append a NEW immutable version record (the
  // declared inputs are never rewritten in place) and advance the context's
  // version pointer (CAS).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/product-contexts/:productContextId/versions',
    defineMutationRoute<{ productContextId: string }, ProductContextDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const agencyId = await resolveAgencyForContext(modules, params.productContextId);
        return { kind: 'agency', agencyId };
      },
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedDeclaration & { expectedVersion: number }>(
          ctx.request.body,
          {
            forbiddenKeys: CONTEXT_CAS_AUTHORITY_FIELDS,
            fields: {
              ...declarationSpec().fields,
              expectedVersion: intField({ min: 1 }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration & { expectedVersion: number };
        return modules.productIntelligence.recordProductContextVersion(
          {
            productContextId: ctx.params.productContextId,
            declaration: toDeclaration(body),
            expectedVersion: body.expectedVersion,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('productintelligence.context.version_recorded', undefined, {
          product_context_id: ctx.result.context.productContextId,
          version_seq: ctx.result.context.currentVersionSeq,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.context.version_recorded',
          targetType: 'product_context',
          targetId: ctx.result.context.productContextId,
          afterVersion: ctx.result.context.version,
          idempotencyKey: `productintelligence.context.version_recorded:${ctx.result.context.productContextId}:${ctx.result.context.currentVersionSeq}`,
          details: {
            versionSeq: ctx.result.context.currentVersionSeq,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/product-contexts/:productContextId/inspections — run the
  // DETERMINISTIC INSPECTION over the current declared inputs (public page
  // fetch/extract through the GET-only reader + authorized reads through
  // the READ-ONLY /integrations port; every outcome recorded honestly).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/product-contexts/:productContextId/inspections',
    defineMutationRoute<{ productContextId: string }, ProductInspectionRunRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const agencyId = await resolveAgencyForContext(modules, params.productContextId);
        return { kind: 'agency', agencyId };
      },
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        // The body is EMPTY by contract (the inspection reads the CURRENT
        // declared inputs — nothing is caller-steerable; any key is the 422).
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: CONTEXT_CAS_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        return modules.productIntelligence.runProductInspection(
          { productContextId: ctx.params.productContextId },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('productintelligence.inspection.completed', undefined, {
          product_context_id: ctx.result.productContextId,
          inspection_run_id: ctx.result.inspectionRunId,
          status: ctx.result.status,
          facts_retained: ctx.result.factsRetained,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.inspection.completed',
          targetType: 'product_context',
          targetId: ctx.result.productContextId,
          afterVersion: null,
          idempotencyKey: `productintelligence.inspection.completed:${ctx.result.inspectionRunId}`,
          details: {
            status: ctx.result.status,
            factsRetained: ctx.result.factsRetained,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInspectionRun(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/product-contexts/:productContextId/derived-models — record
  // one derived model CLAIM (evidence-linked; the verification state is
  // SERVER-COMPUTED from the cited evidence — never a request field).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/product-contexts/:productContextId/derived-models',
    defineMutationRoute<{ productContextId: string }, ProductDerivedModelRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const agencyId = await resolveAgencyForContext(modules, params.productContextId);
        return { kind: 'agency', agencyId };
      },
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          derivationKind: string;
          statement: Record<string, unknown>;
          evidenceSourceFactIds: string[];
          aiAssistance:
            | { modelRegistryId: string; callReference: string }
            | undefined;
          supersedesDerivedModelId: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: DERIVED_MODEL_AUTHORITY_FIELDS,
          fields: {
            derivationKind: stringField({ pattern: DERIVATION_KIND_PATTERN }),
            statement: recordField({ maxDepthKeys: 16, forbiddenKeys: ['provenance'] }),
            evidenceSourceFactIds: arrayField({
              maxItems: 50,
              item: stringField({ pattern: UUID_PATTERN }),
            }),
            aiAssistance: optionalObjectField({
              forbiddenKeys: ['provenance'],
              fields: {
                modelRegistryId: stringField({ pattern: UUID_PATTERN }),
                callReference: stringField({ minLength: 1, maxLength: 500 }),
              },
            }),
            supersedesDerivedModelId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          derivationKind: string;
          statement: Record<string, unknown>;
          evidenceSourceFactIds: string[];
          aiAssistance: { modelRegistryId: string; callReference: string } | undefined;
          supersedesDerivedModelId: string | undefined;
        };
        return modules.productIntelligence.recordDerivedModel(
          {
            productContextId: ctx.params.productContextId,
            derivationKind: body.derivationKind as ProductDerivedModelRecord['derivationKind'],
            statement: body.statement,
            evidenceSourceFactIds: body.evidenceSourceFactIds,
            aiAssistance:
              body.aiAssistance === undefined
                ? null
                : {
                    modelRegistryId: body.aiAssistance.modelRegistryId,
                    callReference: body.aiAssistance.callReference,
                  },
            supersedesDerivedModelId: body.supersedesDerivedModelId ?? null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('productintelligence.derived_model.recorded', undefined, {
          product_context_id: ctx.result.productContextId,
          derived_model_id: ctx.result.derivedModelId,
          derivation_kind: ctx.result.derivationKind,
          verification_state: ctx.result.verificationState,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.derived_model.recorded',
          targetType: 'product_context',
          targetId: ctx.result.productContextId,
          afterVersion: null,
          idempotencyKey: `productintelligence.derived_model.recorded:${ctx.result.derivedModelId}`,
          details: {
            derivationKind: ctx.result.derivationKind,
            verificationState: ctx.result.verificationState,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeDerivedModel(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/product-contexts/:productContextId/risk-flags — record one
  // risk flag (compliance/privacy/toxicity/commercial/operational +
  // severity; evidence-linked; append-only).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/product-contexts/:productContextId/risk-flags',
    defineMutationRoute<{ productContextId: string }, ProductRiskFlagRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const agencyId = await resolveAgencyForContext(modules, params.productContextId);
        return { kind: 'agency', agencyId };
      },
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.productContextId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          category: string;
          severity: string;
          statement: Record<string, unknown>;
          mitigation: string | undefined;
          evidenceSourceFactIds: string[];
        }>(ctx.request.body, {
          forbiddenKeys: RISK_FLAG_AUTHORITY_FIELDS,
          fields: {
            category: stringField({ pattern: CATEGORY_PATTERN }),
            severity: stringField({ pattern: SEVERITY_PATTERN }),
            statement: recordField({ maxDepthKeys: 16, forbiddenKeys: ['provenance'] }),
            mitigation: optionalString({ maxLength: 2000 }),
            evidenceSourceFactIds: arrayField({
              maxItems: 50,
              item: stringField({ pattern: UUID_PATTERN }),
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          category: string;
          severity: string;
          statement: Record<string, unknown>;
          mitigation: string | undefined;
          evidenceSourceFactIds: string[];
        };
        return modules.productIntelligence.recordProductRiskFlag(
          {
            productContextId: ctx.params.productContextId,
            category: body.category as ProductRiskFlagRecord['category'],
            severity: body.severity as ProductRiskFlagRecord['severity'],
            statement: body.statement,
            mitigation: body.mitigation ?? null,
            evidenceSourceFactIds: body.evidenceSourceFactIds,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('productintelligence.risk_flag.recorded', undefined, {
          product_context_id: ctx.result.productContextId,
          risk_flag_id: ctx.result.riskFlagId,
          category: ctx.result.category,
          severity: ctx.result.severity,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.risk_flag.recorded',
          targetType: 'product_context',
          targetId: ctx.result.productContextId,
          afterVersion: null,
          idempotencyKey: `productintelligence.risk_flag.recorded:${ctx.result.riskFlagId}`,
          details: {
            category: ctx.result.category,
            severity: ctx.result.severity,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeRiskFlag(ctx.result)),
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves the owning agency id of a product context (uniform 404 when unknown). */
async function resolveAgencyForContext(
  modules: ApplicationModules,
  productContextId: string,
): Promise<string> {
  if (!UUID_PATTERN.test(productContextId)) {
    throw new NotFoundError('product context', productContextId);
  }
  const ownership = await modules.productIntelligence.resolveProductContextOwnership(productContextId);
  if (ownership === null) {
    throw new NotFoundError('product context', productContextId);
  }
  return ownership.context.agencyId;
}
