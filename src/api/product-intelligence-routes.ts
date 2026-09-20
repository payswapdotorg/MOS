/**
 * /api/product-contexts/* routes (MKT-069 — Product Intelligence: the
 * durable Product Context + inspection + derived-model + risk-flag
 * surface).
 *
 *   POST /api/agencies/:agencyId/product-contexts                       create (owner|admin|platform admin|service)
 *   GET  /api/agencies/:agencyId/product-contexts                       the agency's product contexts (any active member)
 *   GET  /api/product-contexts/:contextId                               the composed honest read-back (record + current version + inputs + facts + derived models + risk flags) (any active member of the owning agency)
 *   GET  /api/product-contexts/:contextId/versions                      the append-only version tail (any active member)
 *   GET  /api/product-contexts/:contextId/source-facts                  the append-only source-fact ledger (any active member)
 *   GET  /api/product-contexts/:contextId/derived-models                the derived model records (any active member)
 *   GET  /api/product-contexts/:contextId/risk-flags                    the risk flags (any active member)
 *   POST /api/product-contexts/:contextId/versions                      record a NEW declared version — the correction path (owner|admin; CAS)
 *   POST /api/product-contexts/:contextId/inspection                    run the READ-ONLY inspection pipeline (fetch public inputs; read authorized inputs) (owner|admin; CAS)
 *   POST /api/product-contexts/:contextId/derived-models                record a derived model record (owner|admin)
 *   POST /api/product-contexts/:contextId/risk-flags                    record a risk flag (owner|admin)
 *
 * SURFACE DISCIPLINE (the dispatch boundary battery): GET/POST ONLY — no
 * PUT, no PATCH, no DELETE (asserted by
 * tests/architecture/product-intelligence-boundary.test.ts). The declared
 * content is never rewritten in place: corrections are NEW version
 * records (POST .../versions); derived records and risk flags are
 * append-only. The inspection is fetch/read operations ONLY (boundary
 * rule 7) — NO write verb toward any external source exists anywhere in
 * this family, and the documented future write seam
 * (PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM) deliberately has NO route.
 * NO mission-strategy verb exists anywhere in this family — MKT-070 (the
 * Product Marketing Mission Planner) is a later Work Item and will attach
 * these records BY REFERENCE through the read surface, never this
 * surface.
 *
 * Server-derived scope posture (implementation-contract §3/§23; the
 * growth-missions precedent): every surface resolves the caller's
 * authorization context and the canonical scope from durable state
 * BEFORE the module call; the path identifiers only SELECT which durable
 * scope gets resolved (a caller-supplied identifier is never an
 * authorization). Uniform 404 for foreign/unknown/malformed
 * agency/context identifiers (no existence oracle — foreign ≡ unknown ≡
 * malformed); a suspended membership or disabled identity is the 403;
 * anonymous calls fail closed 401 at the authenticator. Provenance is
 * SERVER-DERIVED from the authenticated principal + the ambient
 * correlation context (never a request field; the DTOs reject every
 * provenance-shaped key).
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
  intField,
  objectField,
  optionalArrayField,
  optionalRecordField,
  optionalString,
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
  ProductContextDetail,
  ProductContextInputRecord,
  ProductContextRecord,
  ProductContextVersionRecord,
  ProductDerivedModelRecord,
  ProductIntelligenceProvenance,
  ProductRiskFlagRecord,
  ProductSourceFactRecord,
} from '../modules/product-intelligence/public.ts';
import {
  PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES,
  PRODUCT_INTELLIGENCE_DERIVATION_KINDS,
  PRODUCT_INTELLIGENCE_INPUT_KINDS,
  PRODUCT_INTELLIGENCE_RISK_KINDS,
  PRODUCT_INTELLIGENCE_RISK_SEVERITIES,
} from '../modules/product-intelligence/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_KIND_PATTERN = new RegExp(`^(${PRODUCT_INTELLIGENCE_INPUT_KINDS.join('|')})$`);
const AUTHORIZATION_STATE_PATTERN = new RegExp(
  `^(${PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES.join('|')})$`,
);
const DERIVATION_KIND_PATTERN = new RegExp(`^(${PRODUCT_INTELLIGENCE_DERIVATION_KINDS.join('|')})$`);
const RISK_KIND_PATTERN = new RegExp(`^(${PRODUCT_INTELLIGENCE_RISK_KINDS.join('|')})$`);
const RISK_SEVERITY_PATTERN = new RegExp(`^(${PRODUCT_INTELLIGENCE_RISK_SEVERITIES.join('|')})$`);

/** Fields that are always server-derived on CREATE (authority fields). */
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
 * 404 (cross-agency data must 404, not 403-leak existence); a caller
 * with an ACTIVE membership passes (optionally restricted to `roles`); a
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
 * The context-scoped posture: the canonical context ownership (context →
 * owning agency row) resolves from durable state BEFORE authorization —
 * a malformed or unknown context identifier is the uniform 404; a caller
 * with NO membership in the OWNING agency gets the SAME 404 (a foreign
 * context identifier is not a traversal/existence oracle); a suspended
 * membership is the 403. Returns the owning agency id for the pipeline
 * owner scope.
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
  const ownership = await modules.productIntelligence.resolveProductContextOwnership(
    productContextId,
  );
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

/** Optional strict nested-object field (absent passes as undefined). */
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

// The derived-record `detail` payload is a free-form bounded JSON object
// (arbitrary keys preserved) with the authority-field rejection.
const DETAIL_SPEC = optionalRecordField({
  maxDepthKeys: 20,
  forbiddenKeys: ['provenance'],
});

type ValidatedInput = {
  readonly inputKind: string;
  readonly reference: string;
  readonly authorizationState: string;
  readonly authorizationRef: string | undefined;
  readonly notes: string | undefined;
};

type ValidatedDeclaration = {
  readonly name: string;
  readonly summary: string | undefined;
  readonly inputs: readonly ValidatedInput[] | undefined;
};

type ValidatedAiAssistance = {
  readonly modelIdentity: string;
  readonly callReference: string;
};

function inputSpec() {
  return objectField<ValidatedInput>({
    forbiddenKeys: ['provenance'],
    fields: {
      inputKind: stringField({ pattern: INPUT_KIND_PATTERN }),
      reference: stringField({ minLength: 1, maxLength: 2048 }),
      authorizationState: stringField({ pattern: AUTHORIZATION_STATE_PATTERN }),
      authorizationRef: optionalString({ minLength: 1, maxLength: 36, pattern: UUID_PATTERN }),
      notes: optionalString({ maxLength: 2000 }),
    },
  });
}

function declarationSpec() {
  return {
    name: stringField({ minLength: 1, maxLength: 500 }),
    summary: optionalString({ maxLength: 5000 }),
    inputs: optionalArrayField({ maxItems: 50, item: inputSpec() }),
  };
}

/** Maps the validated DTO onto the module declaration input. */
function toDeclaration(body: ValidatedDeclaration) {
  return {
    name: body.name,
    summary: body.summary ?? null,
    inputs: (body.inputs ?? []).map(
      (input): {
        inputKind: ProductContextInputRecord['inputKind'];
        reference: string;
        authorizationState: ProductContextInputRecord['authorizationState'];
        authorizationRef: string | null;
        notes: string | null;
      } => ({
        inputKind: input.inputKind as ProductContextInputRecord['inputKind'],
        reference: input.reference,
        authorizationState: input.authorizationState as ProductContextInputRecord['authorizationState'],
        authorizationRef: input.authorizationRef ?? null,
        notes: input.notes ?? null,
      }),
    ),
  };
}

function aiAssistanceSpec() {
  return optionalObjectField<ValidatedAiAssistance>({
    forbiddenKeys: ['provenance'],
    fields: {
      modelIdentity: stringField({ minLength: 1, maxLength: 200 }),
      callReference: stringField({ minLength: 1, maxLength: 100 }),
    },
  });
}

type ValidatedDerivedModel = {
  readonly derivationKind: string;
  readonly statement: string;
  readonly detail: Record<string, unknown> | undefined;
  readonly sourceFactIds: readonly string[] | undefined;
  readonly evidenceCitations: readonly string[] | undefined;
  readonly aiAssistance: ValidatedAiAssistance | undefined;
};

type ValidatedRiskFlag = {
  readonly riskKind: string;
  readonly severity: string;
  readonly statement: string;
  readonly sourceFactIds: readonly string[] | undefined;
  readonly evidenceCitations: readonly string[] | undefined;
  readonly aiAssistance: ValidatedAiAssistance | undefined;
};

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

function serializeVersion(version: ProductContextVersionRecord): Record<string, unknown> {
  return {
    productContextVersionId: version.productContextVersionId,
    productContextId: version.productContextId,
    versionSeq: version.versionSeq,
    name: version.name,
    summary: version.summary,
    provenance: serializeProvenance(version.provenance),
  };
}

function serializeInput(input: ProductContextInputRecord): Record<string, unknown> {
  return {
    inputId: input.inputId,
    productContextVersionId: input.productContextVersionId,
    inputKind: input.inputKind,
    reference: input.reference,
    authorizationState: input.authorizationState,
    authorizationRef: input.authorizationRef,
    notes: input.notes,
  };
}

function serializeFact(fact: ProductSourceFactRecord): Record<string, unknown> {
  return {
    sourceFactId: fact.sourceFactId,
    productContextId: fact.productContextId,
    productContextVersionId: fact.productContextVersionId,
    inputId: fact.inputId,
    sourceUrl: fact.sourceUrl,
    fetchedAt: fact.fetchedAt,
    extractor: fact.extractor,
    contentHash: fact.contentHash,
    extractionNotes: fact.extractionNotes,
    observation: fact.observation,
    provenance: serializeProvenance(fact.provenance),
  };
}

function serializeAiAssistance(
  aiAssistance: ProductDerivedModelRecord['aiAssistance'],
): Record<string, unknown> | null {
  return aiAssistance === null
    ? null
    : {
        modelIdentity: aiAssistance.modelIdentity,
        callReference: aiAssistance.callReference,
      };
}

function serializeDerivedModel(record: ProductDerivedModelRecord): Record<string, unknown> {
  return {
    derivedModelId: record.derivedModelId,
    productContextId: record.productContextId,
    productContextVersionId: record.productContextVersionId,
    derivationKind: record.derivationKind,
    statement: record.statement,
    detail: record.detail,
    sourceFactIds: record.sourceFactIds,
    evidenceCitations: record.evidenceCitations,
    aiAssistance: serializeAiAssistance(record.aiAssistance),
    verificationState: record.verificationState,
    hypothesis: record.hypothesis,
    provenance: serializeProvenance(record.provenance),
  };
}

function serializeRiskFlag(flag: ProductRiskFlagRecord): Record<string, unknown> {
  return {
    riskFlagId: flag.riskFlagId,
    productContextId: flag.productContextId,
    productContextVersionId: flag.productContextVersionId,
    riskKind: flag.riskKind,
    severity: flag.severity,
    statement: flag.statement,
    sourceFactIds: flag.sourceFactIds,
    evidenceCitations: flag.evidenceCitations,
    aiAssistance: serializeAiAssistance(flag.aiAssistance),
    provenance: serializeProvenance(flag.provenance),
  };
}

function serializeDetail(detail: ProductContextDetail): Record<string, unknown> {
  return {
    context: serializeContext(detail.context),
    currentVersion: serializeVersion(detail.currentVersion),
    inputs: detail.inputs.map(serializeInput),
    sourceFacts: detail.sourceFacts.map(serializeFact),
    derivedModels: detail.derivedModels.map(serializeDerivedModel),
    riskFlags: detail.riskFlags.map(serializeRiskFlag),
    vocabularyVersion: detail.vocabularyVersion,
    inspectionCapability: detail.inspectionCapability,
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
  // Product Context (born at version 1 of the declared content: the product
  // name + summary + the declared inputs, each carrying its authorization
  // state). Agency ownership comes from the PATH and resolves canonically
  // BEFORE authorization; context identity, provenance and timestamps are
  // server-derived.
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
      validate: (ctx) =>
        validateObject<ValidatedDeclaration>(ctx.request.body, {
          forbiddenKeys: CONTEXT_CREATE_AUTHORITY_FIELDS,
          fields: declarationSpec(),
        }),
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
          input_count: ctx.result.inputs.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.context.created',
          targetType: 'product_context',
          targetId: ctx.result.context.productContextId,
          afterVersion: ctx.result.context.version,
          idempotencyKey: `productintelligence.context.created:${ctx.result.context.productContextId}`,
          details: {
            name: ctx.result.currentVersion.name,
            inputs: ctx.result.inputs.length,
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
          productContexts: ctx.result.map(serializeContext),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:contextId — the composed honest read-back:
  // the record + the CURRENT declared version + its inputs + the complete
  // source-fact ledger + the derived model records + the risk flags + the
  // vocabulary/read-only disclosures (the AC-6 mission-attachment seam).
  // Foreign/unknown → uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:contextId',
    defineQueryRoute<{ contextId: string }, ProductContextDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.contextId);
      },
      execute: async (ctx) => {
        const detail = await modules.productIntelligence.getProductContextDetail(
          ctx.params.contextId,
        );
        if (detail === null) {
          throw new NotFoundError('product context', ctx.params.contextId);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:contextId/versions — the append-only
  // declared-context version tail (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:contextId/versions',
    defineQueryRoute<{ contextId: string }, readonly ProductContextVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.contextId);
      },
      execute: async (ctx) => {
        const versions = await modules.productIntelligence.getProductContextVersions(
          ctx.params.contextId,
        );
        if (versions === null) {
          throw new NotFoundError('product context', ctx.params.contextId);
        }
        return versions;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          productContextId: ctx.params.contextId,
          versions: ctx.result.map(serializeVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:contextId/source-facts — the append-only
  // source-fact ledger with full provenance (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:contextId/source-facts',
    defineQueryRoute<{ contextId: string }, readonly ProductSourceFactRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.contextId);
      },
      execute: async (ctx) => {
        const facts = await modules.productIntelligence.getSourceFacts(ctx.params.contextId);
        if (facts === null) {
          throw new NotFoundError('product context', ctx.params.contextId);
        }
        return facts;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          productContextId: ctx.params.contextId,
          sourceFacts: ctx.result.map(serializeFact),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:contextId/derived-models — the derived
  // model records (oldest first; verification states + hypothesis flags
  // ship on every record).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:contextId/derived-models',
    defineQueryRoute<{ contextId: string }, readonly ProductDerivedModelRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.contextId);
      },
      execute: async (ctx) => {
        const models = await modules.productIntelligence.getDerivedModels(ctx.params.contextId);
        if (models === null) {
          throw new NotFoundError('product context', ctx.params.contextId);
        }
        return models;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          productContextId: ctx.params.contextId,
          derivedModels: ctx.result.map(serializeDerivedModel),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/product-contexts/:contextId/risk-flags — the risk flags
  // (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/product-contexts/:contextId/risk-flags',
    defineQueryRoute<{ contextId: string }, readonly ProductRiskFlagRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.contextId);
      },
      execute: async (ctx) => {
        const flags = await modules.productIntelligence.getRiskFlags(ctx.params.contextId);
        if (flags === null) {
          throw new NotFoundError('product context', ctx.params.contextId);
        }
        return flags;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          productContextId: ctx.params.contextId,
          riskFlags: ctx.result.map(serializeRiskFlag),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/product-contexts/:contextId/versions — the declared-content
  // CORRECTION path: append a NEW immutable declared version (the declared
  // content is never rewritten in place) and advance the version pointer
  // (CAS).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/product-contexts/:contextId/versions',
    defineMutationRoute<{ contextId: string }, ProductContextDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.contextId)) {
          throw new NotFoundError('product context', params.contextId);
        }
        const ownership = await modules.productIntelligence.resolveProductContextOwnership(
          params.contextId,
        );
        if (ownership === null) {
          throw new NotFoundError('product context', params.contextId);
        }
        return { kind: 'agency', agencyId: ownership.context.agencyId };
      },
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.contextId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedDeclaration & { version: number }>(ctx.request.body, {
          forbiddenKeys: CONTEXT_CAS_AUTHORITY_FIELDS,
          fields: {
            ...declarationSpec(),
            version: intField({ min: 1 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration & { version: number };
        return modules.productIntelligence.recordProductContextVersion(
          {
            productContextId: ctx.params.contextId,
            declaration: toDeclaration(body),
            expectedVersion: body.version,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('productintelligence.context.versionrecorded', undefined, {
          product_context_id: ctx.params.contextId,
          version_seq: ctx.result.context.currentVersionSeq,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.context.versionrecorded',
          targetType: 'product_context',
          targetId: ctx.params.contextId,
          afterVersion: ctx.result.context.version,
          idempotencyKey: `productintelligence.context.versionrecorded:${ctx.result.context.version}`,
          details: {
            versionSeq: ctx.result.context.currentVersionSeq,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/product-contexts/:contextId/inspection — run the READ-ONLY
  // inspection pipeline over the CURRENT declared version's inputs (fetch
  // public sources; read authorized sources through /integrations; append
  // the source facts). CAS; all-or-nothing.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/product-contexts/:contextId/inspection',
    defineMutationRoute<{ contextId: string }, ProductContextDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.contextId)) {
          throw new NotFoundError('product context', params.contextId);
        }
        const ownership = await modules.productIntelligence.resolveProductContextOwnership(
          params.contextId,
        );
        if (ownership === null) {
          throw new NotFoundError('product context', params.contextId);
        }
        return { kind: 'agency', agencyId: ownership.context.agencyId };
      },
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.contextId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ version: number }>(ctx.request.body, {
          forbiddenKeys: CONTEXT_CAS_AUTHORITY_FIELDS,
          fields: {
            version: intField({ min: 1 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { version: number };
        return modules.productIntelligence.inspectProductContext(
          {
            productContextId: ctx.params.contextId,
            expectedVersion: body.version,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('productintelligence.context.inspected', undefined, {
          product_context_id: ctx.params.contextId,
          source_fact_count: ctx.result.sourceFacts.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.context.inspected',
          targetType: 'product_context',
          targetId: ctx.params.contextId,
          afterVersion: ctx.result.context.version,
          idempotencyKey: `productintelligence.context.inspected:${ctx.result.sourceFacts.length}:${ctx.result.context.version}`,
          details: {
            sourceFacts: ctx.result.sourceFacts.length,
            inspectionCapability: ctx.result.inspectionCapability,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/product-contexts/:contextId/derived-models — record ONE
  // derived model record (the frozen §8 kind; the backing source-fact
  // references; the server-derived verification state; the ai-assistance
  // disclosure when derived with model help).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/product-contexts/:contextId/derived-models',
    defineMutationRoute<{ contextId: string }, ProductDerivedModelRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.contextId)) {
          throw new NotFoundError('product context', params.contextId);
        }
        const ownership = await modules.productIntelligence.resolveProductContextOwnership(
          params.contextId,
        );
        if (ownership === null) {
          throw new NotFoundError('product context', params.contextId);
        }
        return { kind: 'agency', agencyId: ownership.context.agencyId };
      },
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.contextId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedDerivedModel>(ctx.request.body, {
          forbiddenKeys: CONTEXT_CAS_AUTHORITY_FIELDS,
          fields: {
            derivationKind: stringField({ pattern: DERIVATION_KIND_PATTERN }),
            statement: stringField({ minLength: 1, maxLength: 2000 }),
            detail: DETAIL_SPEC,
            sourceFactIds: optionalArrayField({
              maxItems: 50,
              item: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            }),
            evidenceCitations: optionalArrayField({
              maxItems: 50,
              item: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            }),
            aiAssistance: aiAssistanceSpec(),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDerivedModel;
        return modules.productIntelligence.recordDerivedModel(
          {
            productContextId: ctx.params.contextId,
            derivationKind: body.derivationKind as ProductDerivedModelRecord['derivationKind'],
            statement: body.statement,
            detail: body.detail === undefined ? null : body.detail,
            sourceFactIds: body.sourceFactIds ?? [],
            evidenceCitations: body.evidenceCitations ?? [],
            aiAssistance:
              body.aiAssistance === undefined
                ? null
                : {
                    modelIdentity: body.aiAssistance.modelIdentity,
                    callReference: body.aiAssistance.callReference,
                  },
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('productintelligence.derivedmodel.recorded', undefined, {
          product_context_id: ctx.params.contextId,
          derivation_kind: ctx.result.derivationKind,
          verification_state: ctx.result.verificationState,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.derivedmodel.recorded',
          targetType: 'product_context',
          targetId: ctx.params.contextId,
          afterVersion: null,
          idempotencyKey: `productintelligence.derivedmodel.recorded:${ctx.result.derivedModelId}`,
          details: {
            derivedModelId: ctx.result.derivedModelId,
            derivationKind: ctx.result.derivationKind,
            verificationState: ctx.result.verificationState,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeDerivedModel(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/product-contexts/:contextId/risk-flags — record ONE risk
  // flag (the frozen risk-kind + severity vocabularies; the same
  // evidence-backing discipline).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/product-contexts/:contextId/risk-flags',
    defineMutationRoute<{ contextId: string }, ProductRiskFlagRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.contextId)) {
          throw new NotFoundError('product context', params.contextId);
        }
        const ownership = await modules.productIntelligence.resolveProductContextOwnership(
          params.contextId,
        );
        if (ownership === null) {
          throw new NotFoundError('product context', params.contextId);
        }
        return { kind: 'agency', agencyId: ownership.context.agencyId };
      },
      authorize: async (ctx) => {
        await requireProductContextAccess(modules, ctx.principal, ctx.params.contextId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedRiskFlag>(ctx.request.body, {
          forbiddenKeys: CONTEXT_CAS_AUTHORITY_FIELDS,
          fields: {
            riskKind: stringField({ pattern: RISK_KIND_PATTERN }),
            severity: stringField({ pattern: RISK_SEVERITY_PATTERN }),
            statement: stringField({ minLength: 1, maxLength: 2000 }),
            sourceFactIds: optionalArrayField({
              maxItems: 50,
              item: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            }),
            evidenceCitations: optionalArrayField({
              maxItems: 50,
              item: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            }),
            aiAssistance: aiAssistanceSpec(),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedRiskFlag;
        return modules.productIntelligence.recordRiskFlag(
          {
            productContextId: ctx.params.contextId,
            riskKind: body.riskKind as ProductRiskFlagRecord['riskKind'],
            severity: body.severity as ProductRiskFlagRecord['severity'],
            statement: body.statement,
            sourceFactIds: body.sourceFactIds ?? [],
            evidenceCitations: body.evidenceCitations ?? [],
            aiAssistance:
              body.aiAssistance === undefined
                ? null
                : {
                    modelIdentity: body.aiAssistance.modelIdentity,
                    callReference: body.aiAssistance.callReference,
                  },
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('productintelligence.riskflag.recorded', undefined, {
          product_context_id: ctx.params.contextId,
          risk_kind: ctx.result.riskKind,
          severity: ctx.result.severity,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productintelligence.riskflag.recorded',
          targetType: 'product_context',
          targetId: ctx.params.contextId,
          afterVersion: null,
          idempotencyKey: `productintelligence.riskflag.recorded:${ctx.result.riskFlagId}`,
          details: {
            riskFlagId: ctx.result.riskFlagId,
            riskKind: ctx.result.riskKind,
            severity: ctx.result.severity,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeRiskFlag(ctx.result)),
    }),
  );
}
