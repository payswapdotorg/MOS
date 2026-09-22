/**
 * /api/research-sessions/* routes (MKT-062 — Web Research: the durable
 * research session and source fact surface).
 *
 *   POST /api/agencies/:agencyId/research-sessions                          create (owner|admin)
 *   GET  /api/agencies/:agencyId/research-sessions                          the agency's sessions (any active member)
 *   GET  /api/research-sessions/:researchSessionId                          the composed honest read-back (record + current declaration + versions + facts + insights + runs) (any active member of the owning agency)
 *   GET  /api/research-sessions/:researchSessionId/versions                 the append-only version tail (any active member)
 *   GET  /api/research-sessions/:researchSessionId/facts                    the retained source-fact tail (any active member)
 *   GET  /api/research-sessions/:researchSessionId/insights                 the research insights with evidence links (any active member)
 *   GET  /api/research-sessions/:researchSessionId/runs                     the research runs with per-source outcomes (any active member)
 *   POST /api/research-sessions/:researchSessionId/versions                 record a NEW declared version — the correction path (owner|admin; CAS)
 *   POST /api/research-sessions/:researchSessionId/runs                     run the deterministic research pass (owner|admin; empty body)
 *   POST /api/research-sessions/:researchSessionId/insights                 record one research insight claim (owner|admin; evidence-linked; AI disclosure)
 *
 * SURFACE DISCIPLINE (the boundary battery): GET/POST ONLY — no PUT, no
 * PATCH, no DELETE (asserted by tests/architecture/research-boundary.test.ts).
 * The declared sources are never rewritten in place: corrections are NEW
 * version records (POST .../versions). NO mutation toward any research
 * source exists (§7 — the research POST is the bounded deterministic
 * fetch/extract over already declared sources; the page-reader port has
 * no method field and the integrations port exposes executeRead ONLY).
 *
 * Server-derived scope posture (implementation-contract §3/§23; the
 * product-intelligence precedent): every surface resolves the caller's
 * authorization context and the canonical scope from durable state BEFORE
 * the module call; the path identifiers only SELECT which durable scope
 * gets resolved (a caller-supplied identifier is never an authorization).
 * Uniform 404 for foreign/unknown/malformed agency/session identifiers
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
  ResearchInsightRecord,
  ResearchProvenance,
  ResearchRunRecord,
  ResearchSessionDeclarationInput,
  ResearchSessionDetail,
  ResearchSessionRecord,
  ResearchSessionVersionRecord,
  ResearchSourceDeclaration,
  ResearchSourceFactRecord,
} from '../modules/research/public.ts';
import {
  RESEARCH_AUTHORIZATION_STATES,
  RESEARCH_SOURCE_KINDS,
} from '../modules/research/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_PATTERN = new RegExp(`^(${RESEARCH_SOURCE_KINDS.join('|')})$`);
const AUTHORIZATION_PATTERN = new RegExp(`^(${RESEARCH_AUTHORIZATION_STATES.join('|')})$`);

/** Fields that are always server-derived (authority fields). */
const SESSION_CREATE_AUTHORITY_FIELDS = [
  'researchSessionId',
  'agencyId',
  'currentVersionSeq',
  'version',
  'createdActor',
  'createdAt',
  'updatedAt',
  'provenance',
] as const;

/** CAS mutations legitimately receive `version`; identity/scope/provenance are rejected. */
const SESSION_CAS_AUTHORITY_FIELDS = [
  'researchSessionId',
  'agencyId',
  'currentVersionSeq',
  'createdActor',
  'createdAt',
  'updatedAt',
  'provenance',
] as const;

const INSIGHT_AUTHORITY_FIELDS = [
  'researchInsightId',
  'researchSessionId',
  'verificationState',
  'supersededByResearchInsightId',
  'aiModelDisplay',
  'provenance',
] as const;

// ---------------------------------------------------------------------------
// Server-derived provenance (never a request field)
// ---------------------------------------------------------------------------

function serverProvenance(principal: Principal): ResearchProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Authorization (the product-intelligence fail-closed posture)
// ---------------------------------------------------------------------------

/**
 * The agency-scoped posture: the durable agency row and the caller's
 * membership in THAT agency resolve from durable state BEFORE the module
 * call. A malformed, unknown or FOREIGN agency identifier is the uniform
 * 404 (cross-agency data must 404, not 403-leak existence); a caller with
 * an ACTIVE membership passes (optionally restricted to `roles`); a
 * suspended membership or a disabled identity is the 403.
 */
async function requireResearchAgency(
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
 * The session-scoped posture: the canonical research-session ownership
 * resolves from durable state BEFORE authorization — a malformed or
 * unknown session identifier is the uniform 404; a caller with NO
 * membership in the OWNING agency gets the SAME 404 (a foreign session
 * identifier is not a traversal/existence oracle); a suspended membership
 * is the 403. Returns the owning agency id for the pipeline owner scope.
 */
async function requireResearchSessionAccess(
  modules: ApplicationModules,
  principal: Principal,
  researchSessionId: string,
  roles?: ReadonlyArray<string>,
): Promise<string> {
  if (!UUID_PATTERN.test(researchSessionId)) {
    throw new NotFoundError('research session', researchSessionId);
  }
  const ownership = await modules.research.resolveResearchSessionOwnership(researchSessionId);
  if (ownership === null) {
    throw new NotFoundError('research session', researchSessionId);
  }
  const agencyId = ownership.session.agencyId;

  if (principal.kind === 'service') return agencyId;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return agencyId;

  const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
  if (membership === undefined) {
    // Hard boundary: not a member of the OWNING agency → indistinguishable
    // from an unknown session (uniform 404, no cross-tenant oracle).
    throw new NotFoundError('research session', researchSessionId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the research session agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return agencyId;
}

// ---------------------------------------------------------------------------
// DTO specs (strict validation — the product-intelligence discipline)
// ---------------------------------------------------------------------------

type ValidatedSource = {
  kind: string;
  reference: string;
  authorization: string;
  integrationConnectionId: string | undefined;
};

type ValidatedDeclaration = {
  topic: string | undefined;
  focus: string | undefined;
  sources: ValidatedSource[];
};

function sourceSpec() {
  return objectField<ValidatedSource>({
    forbiddenKeys: ['provenance'],
    fields: {
      kind: stringField({ pattern: KIND_PATTERN }),
      reference: stringField({ minLength: 1, maxLength: 2048 }),
      authorization: stringField({ pattern: AUTHORIZATION_PATTERN }),
      integrationConnectionId: optionalString({ pattern: UUID_PATTERN }),
    },
  });
}

/** Optional strict nested-object field (absent passes as undefined — the product-intelligence precedent). */
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
    forbiddenKeys: SESSION_CREATE_AUTHORITY_FIELDS,
    fields: {
      topic: optionalString({ maxLength: 500 }),
      focus: optionalString({ maxLength: 2000 }),
      sources: arrayField({ minItems: 1, maxItems: 40, item: sourceSpec() }),
    },
  };
}

/** Maps the validated DTO onto the module declaration input. */
function toDeclaration(body: ValidatedDeclaration): ResearchSessionDeclarationInput {
  return {
    topic: body.topic ?? null,
    focus: body.focus ?? null,
    sources: body.sources.map(
      (source): ResearchSourceDeclaration => ({
        kind: source.kind as ResearchSourceDeclaration['kind'],
        reference: source.reference,
        authorization: source.authorization as ResearchSourceDeclaration['authorization'],
        integrationConnectionId: source.integrationConnectionId ?? null,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Serialization (presentation only; every field of the record ships)
// ---------------------------------------------------------------------------

function serializeProvenance(
  provenance: ResearchSessionVersionRecord['provenance'],
): Record<string, unknown> {
  return {
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
    recordedAt: provenance.recordedAt,
  };
}

function serializeSession(session: ResearchSessionRecord): Record<string, unknown> {
  return {
    researchSessionId: session.researchSessionId,
    agencyId: session.agencyId,
    currentVersionSeq: session.currentVersionSeq,
    version: session.version,
    createdActor: session.createdActor,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function serializeSource(source: ResearchSessionVersionRecord['sources'][number]): Record<string, unknown> {
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    reference: source.reference,
    authorization: source.authorization,
    integrationConnectionId: source.integrationConnectionId,
    position: source.position,
  };
}

function serializeVersion(version: ResearchSessionVersionRecord): Record<string, unknown> {
  return {
    researchSessionVersionId: version.researchSessionVersionId,
    researchSessionId: version.researchSessionId,
    versionSeq: version.versionSeq,
    topic: version.topic,
    focus: version.focus,
    sources: version.sources.map(serializeSource),
    provenance: serializeProvenance(version.provenance),
  };
}

function serializeSourceFact(fact: ResearchSourceFactRecord): Record<string, unknown> {
  return {
    sourceFactId: fact.sourceFactId,
    researchSessionId: fact.researchSessionId,
    sourceId: fact.sourceId,
    researchRunId: fact.researchRunId,
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

function serializeInsight(insight: ResearchInsightRecord): Record<string, unknown> {
  return {
    researchInsightId: insight.researchInsightId,
    researchSessionId: insight.researchSessionId,
    derivationKind: insight.derivationKind,
    statement: insight.statement,
    verificationState: insight.verificationState,
    supersedesResearchInsightId: insight.supersedesResearchInsightId,
    supersededByResearchInsightId: insight.supersededByResearchInsightId,
    aiAssistance: insight.aiAssistance,
    evidenceSourceFactIds: insight.evidenceSourceFactIds,
    provenance: serializeProvenance(insight.provenance),
  };
}

function serializeRun(run: ResearchRunRecord): Record<string, unknown> {
  return {
    researchRunId: run.researchRunId,
    researchSessionId: run.researchSessionId,
    researchSessionVersionId: run.researchSessionVersionId,
    status: run.status,
    sourcesInspected: run.sourcesInspected,
    factsRetained: run.factsRetained,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    sourceOutcomes: run.sourceOutcomes.map((outcome) => ({
      researchRunSourceOutcomeId: outcome.researchRunSourceOutcomeId,
      sourceId: outcome.sourceId,
      outcome: outcome.outcome,
      detail: outcome.detail,
      factsExtracted: outcome.factsExtracted,
    })),
    provenance: serializeProvenance(run.provenance),
  };
}

function serializeDetail(detail: ResearchSessionDetail): Record<string, unknown> {
  return {
    session: serializeSession(detail.session),
    currentVersion: serializeVersion(detail.currentVersion),
    versions: detail.versions.map(serializeVersion),
    sourceFacts: detail.sourceFacts.map(serializeSourceFact),
    insights: detail.insights.map(serializeInsight),
    runs: detail.runs.map(serializeRun),
    derivedRecordTier: detail.derivedRecordTier,
    vocabularyVersion: detail.vocabularyVersion,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerResearchRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('research.api');

  /** Resolves the owning agency id of a research session (uniform 404 when unknown). */
  async function resolveAgencyForSession(
    modules: ApplicationModules,
    researchSessionId: string,
  ): Promise<string> {
    if (!UUID_PATTERN.test(researchSessionId)) {
      throw new NotFoundError('research session', researchSessionId);
    }
    const ownership = await modules.research.resolveResearchSessionOwnership(researchSessionId);
    if (ownership === null) {
      throw new NotFoundError('research session', researchSessionId);
    }
    return ownership.session.agencyId;
  }

  // -------------------------------------------------------------------------
  // POST /api/agencies/:agencyId/research-sessions — create an
  // agency-scoped research session (version 1 of the declared
  // topic/focus/sources). Agency ownership comes from the PATH and
  // resolves canonically BEFORE authorization; session identity,
  // provenance and timestamps are server-derived; the caller declares the
  // bounded topic/focus and the sources (each with its kind + reference +
  // authorization state) only.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/agencies/:agencyId/research-sessions',
    defineMutationRoute<{ agencyId: string }, ResearchSessionDetail>({
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
        await requireResearchAgency(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => validateObject<ValidatedDeclaration>(ctx.request.body, declarationSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration;
        return modules.research.createResearchSession(
          {
            agencyId: ctx.params.agencyId,
            declaration: toDeclaration(body),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('research.session.created', undefined, {
          research_session_id: ctx.result.session.researchSessionId,
          agency_id: ctx.params.agencyId,
          sources: ctx.result.currentVersion.sources.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'research.session.created',
          targetType: 'research_session',
          targetId: ctx.result.session.researchSessionId,
          afterVersion: ctx.result.session.version,
          idempotencyKey: `research.session.created:${ctx.result.session.researchSessionId}`,
          details: {
            sources: ctx.result.currentVersion.sources.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/agencies/:agencyId/research-sessions — the agency's research
  // sessions (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/agencies/:agencyId/research-sessions',
    defineQueryRoute<{ agencyId: string }, readonly ResearchSessionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireResearchAgency(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.research.listResearchSessionsForAgency(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          sessions: ctx.result.map(serializeSession),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/research-sessions/:researchSessionId — the composed honest
  // read-back (the /content-intelligence + /product-intelligence read
  // surface): record + current declaration + version tail + source facts +
  // insights + runs + the claim-tier disclosure. Foreign/unknown →
  // uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/research-sessions/:researchSessionId',
    defineQueryRoute<{ researchSessionId: string }, ResearchSessionDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireResearchSessionAccess(modules, ctx.principal, ctx.params.researchSessionId);
      },
      execute: async (ctx) => {
        const detail = await modules.research.getResearchSessionDetail(
          ctx.params.researchSessionId,
        );
        if (detail === null) {
          throw new NotFoundError('research session', ctx.params.researchSessionId);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/research-sessions/:researchSessionId/versions — the
  // append-only declared-source version tail (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/research-sessions/:researchSessionId/versions',
    defineQueryRoute<{ researchSessionId: string }, readonly ResearchSessionVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireResearchSessionAccess(modules, ctx.principal, ctx.params.researchSessionId);
      },
      execute: async (ctx) => {
        const versions = await modules.research.getResearchSessionVersions(
          ctx.params.researchSessionId,
        );
        if (versions === null) {
          throw new NotFoundError('research session', ctx.params.researchSessionId);
        }
        return versions;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          researchSessionId: ctx.params.researchSessionId,
          versions: ctx.result.map(serializeVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/research-sessions/:researchSessionId/facts — the retained
  // source-fact tail (oldest first; every fact with FULL provenance:
  // source ref, fetched-at, extractor, content hash, notes).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/research-sessions/:researchSessionId/facts',
    defineQueryRoute<{ researchSessionId: string }, readonly ResearchSourceFactRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireResearchSessionAccess(modules, ctx.principal, ctx.params.researchSessionId);
      },
      execute: async (ctx) => {
        const facts = await modules.research.getResearchSessionFacts(ctx.params.researchSessionId);
        if (facts === null) {
          throw new NotFoundError('research session', ctx.params.researchSessionId);
        }
        return facts;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          researchSessionId: ctx.params.researchSessionId,
          sourceFacts: ctx.result.map(serializeSourceFact),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/research-sessions/:researchSessionId/insights — the research
  // insights with their evidence links + AI disclosure (oldest first;
  // superseded history stays readable).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/research-sessions/:researchSessionId/insights',
    defineQueryRoute<{ researchSessionId: string }, readonly ResearchInsightRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireResearchSessionAccess(modules, ctx.principal, ctx.params.researchSessionId);
      },
      execute: async (ctx) => {
        const insights = await modules.research.getResearchSessionInsights(
          ctx.params.researchSessionId,
        );
        if (insights === null) {
          throw new NotFoundError('research session', ctx.params.researchSessionId);
        }
        return insights;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          researchSessionId: ctx.params.researchSessionId,
          insights: ctx.result.map(serializeInsight),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/research-sessions/:researchSessionId/runs — the research
  // runs with their per-source honest outcomes (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/research-sessions/:researchSessionId/runs',
    defineQueryRoute<{ researchSessionId: string }, readonly ResearchRunRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireResearchSessionAccess(modules, ctx.principal, ctx.params.researchSessionId);
      },
      execute: async (ctx) => {
        const runs = await modules.research.getResearchSessionRuns(ctx.params.researchSessionId);
        if (runs === null) {
          throw new NotFoundError('research session', ctx.params.researchSessionId);
        }
        return runs;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          researchSessionId: ctx.params.researchSessionId,
          runs: ctx.result.map(serializeRun),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/research-sessions/:researchSessionId/versions — the declared
  // source CORRECTION path: append a NEW immutable version record (the
  // declared sources are never rewritten in place) and advance the
  // session's version pointer (CAS).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/research-sessions/:researchSessionId/versions',
    defineMutationRoute<{ researchSessionId: string }, ResearchSessionDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const agencyId = await resolveAgencyForSession(modules, params.researchSessionId);
        return { kind: 'agency', agencyId };
      },
      authorize: async (ctx) => {
        await requireResearchSessionAccess(modules, ctx.principal, ctx.params.researchSessionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedDeclaration & { expectedVersion: number }>(
          ctx.request.body,
          {
            forbiddenKeys: SESSION_CAS_AUTHORITY_FIELDS,
            fields: {
              ...declarationSpec().fields,
              expectedVersion: intField({ min: 1 }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration & { expectedVersion: number };
        return modules.research.recordResearchSessionVersion(
          {
            researchSessionId: ctx.params.researchSessionId,
            declaration: toDeclaration(body),
            expectedVersion: body.expectedVersion,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('research.session.version_recorded', undefined, {
          research_session_id: ctx.result.session.researchSessionId,
          version_seq: ctx.result.session.currentVersionSeq,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'research.session.version_recorded',
          targetType: 'research_session',
          targetId: ctx.result.session.researchSessionId,
          afterVersion: ctx.result.session.version,
          idempotencyKey: `research.session.version_recorded:${ctx.result.session.researchSessionId}:${ctx.result.session.currentVersionSeq}`,
          details: {
            versionSeq: ctx.result.session.currentVersionSeq,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/research-sessions/:researchSessionId/runs — run the
  // DETERMINISTIC RESEARCH PASS over the current declared sources (public
  // page fetch/extract through the GET-only reader + authorized reads
  // through the READ-ONLY /integrations port; every outcome recorded
  // honestly).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/research-sessions/:researchSessionId/runs',
    defineMutationRoute<{ researchSessionId: string }, ResearchRunRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const agencyId = await resolveAgencyForSession(modules, params.researchSessionId);
        return { kind: 'agency', agencyId };
      },
      authorize: async (ctx) => {
        await requireResearchSessionAccess(modules, ctx.principal, ctx.params.researchSessionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        // The body is EMPTY by contract (the research pass reads the
        // CURRENT declared sources — nothing is caller-steerable; any key
        // is the 422).
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: SESSION_CAS_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        return modules.research.runResearch(
          { researchSessionId: ctx.params.researchSessionId },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('research.pass.completed', undefined, {
          research_session_id: ctx.result.researchSessionId,
          research_run_id: ctx.result.researchRunId,
          status: ctx.result.status,
          facts_retained: ctx.result.factsRetained,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'research.pass.completed',
          targetType: 'research_session',
          targetId: ctx.result.researchSessionId,
          afterVersion: null,
          idempotencyKey: `research.pass.completed:${ctx.result.researchRunId}`,
          details: {
            status: ctx.result.status,
            factsRetained: ctx.result.factsRetained,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeRun(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/research-sessions/:researchSessionId/insights — record one
  // research insight CLAIM (evidence-linked; the verification state is
  // SERVER-COMPUTED from the cited evidence — never a request field).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/research-sessions/:researchSessionId/insights',
    defineMutationRoute<{ researchSessionId: string }, ResearchInsightRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const agencyId = await resolveAgencyForSession(modules, params.researchSessionId);
        return { kind: 'agency', agencyId };
      },
      authorize: async (ctx) => {
        await requireResearchSessionAccess(modules, ctx.principal, ctx.params.researchSessionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          derivationKind: string;
          statement: Record<string, unknown>;
          evidenceSourceFactIds: string[];
          aiAssistance: { modelRegistryId: string; callReference: string } | undefined;
          supersedesResearchInsightId: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: INSIGHT_AUTHORITY_FIELDS,
          fields: {
            derivationKind: stringField({
              pattern: /^(topic_synthesis|trend_observation|market_note|audience_signal|competitor_signal|source_critique)$/,
            }),
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
            supersedesResearchInsightId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          derivationKind: string;
          statement: Record<string, unknown>;
          evidenceSourceFactIds: string[];
          aiAssistance: { modelRegistryId: string; callReference: string } | undefined;
          supersedesResearchInsightId: string | undefined;
        };
        return modules.research.recordResearchInsight(
          {
            researchSessionId: ctx.params.researchSessionId,
            derivationKind: body.derivationKind as ResearchInsightRecord['derivationKind'],
            statement: body.statement,
            evidenceSourceFactIds: body.evidenceSourceFactIds,
            aiAssistance:
              body.aiAssistance === undefined
                ? null
                : {
                    modelRegistryId: body.aiAssistance.modelRegistryId,
                    callReference: body.aiAssistance.callReference,
                  },
            supersedesResearchInsightId: body.supersedesResearchInsightId ?? null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('research.insight.recorded', undefined, {
          research_session_id: ctx.result.researchSessionId,
          research_insight_id: ctx.result.researchInsightId,
          derivation_kind: ctx.result.derivationKind,
          verification_state: ctx.result.verificationState,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'research.insight.recorded',
          targetType: 'research_session',
          targetId: ctx.result.researchSessionId,
          afterVersion: null,
          idempotencyKey: `research.insight.recorded:${ctx.result.researchInsightId}`,
          details: {
            derivationKind: ctx.result.derivationKind,
            verificationState: ctx.result.verificationState,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeInsight(ctx.result)),
    }),
  );
}
