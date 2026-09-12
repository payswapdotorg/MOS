/**
 * /experiments API routes (MKT-015, EXP-001).
 *
 *   POST /api/clients/:clientId/experiments            declare one experiment (any active member)
 *   GET  /api/clients/:clientId/experiments            list the Client's declared experiments (any active member)
 *   GET  /api/experiments/:experimentId                read one experiment (member of the OWNING agency)
 *   POST /api/experiments/:experimentId/transitions    apply one lifecycle transition (owner|admin of the OWNING agency)
 *   GET  /api/experiments/:experimentId/transitions    the append-only transition history (member of the OWNING agency)
 *
 * There is deliberately NO experiment update and NO delete route: the
 * declared design is immutable (a DB trigger backstops it), and lifecycle
 * moves ONLY through the explicit frozen-state-machine transitions
 * (spec/state-machines.md) — each one an append-only history row carrying
 * the conclusion payload verbatim when the transition is the conclusion.
 *
 * PROVENANCE IS SERVER-DERIVED on every write: actor from the
 * authenticated principal, correlation from the ambient correlation
 * context, recording system ('api') and recordedAt from the module clock.
 * The request DTOs reject every provenance-shaped authority field AND
 * every lifecycle/result authority field (status, resultState, decision)
 * — a caller can never supply identity, ownership, provenance, lifecycle
 * state or the platform's own recording timestamps. On the CREATE surface
 * the caller declares the full §16 design payload only; on the TRANSITION
 * surface the caller names the transition and (for 'conclude' ONLY) its
 * conclusion payload. Everything semantic (closed taxonomies, the causal
 * evidence standard, uncertainty-representation matching, analysis
 * metadata retention, evidence-citation tenancy) is validated by the
 * module guards — the route DTO validates shape only.
 *
 * Authorization follows the established hard-boundary posture: the owning
 * Client is resolved from durable state BEFORE authorize (uniform 404 for
 * unknown/foreign identifiers — no cross-tenant oracle), and every
 * experiment-scoped route resolves the canonical owner chain
 * experiment → client → agency before any dependent traversal.
 */

import { NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
  type PipelineContext,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import type { FieldSpec, ObjectSpec } from '../platform/http/validation.ts';
import {
  objectField,
  optionalArrayField,
  optionalRecordField,
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import { requireClientAccess, requireExperimentAccess } from './authorize.ts';
import type {
  ExperimentConclusion,
  ExperimentMetricIdentity,
  ExperimentRecord,
  ExperimentTransition,
  ExperimentTransitionRecord,
  ExperimentUncertainty,
} from '../modules/experiments/public.ts';

const EXPERIMENT_DESIGN_PATTERN =
  /^(randomized|controlled_comparison|quasi_experimental|observational|descriptive)$/;
const EXPERIMENT_DIRECTION_PATTERN = /^(increase|decrease|no_change|any)$/;
const EXPERIMENT_UNCERTAINTY_REPRESENTATION_PATTERN = /^(interval|distribution|qualitative|none)$/;
const EXPERIMENT_TRANSITION_PATTERN =
  /^(mark_ready|start|begin_analysis|conclude|stop|invalidate)$/;
const EXPERIMENT_CONCLUSION_RESULT_STATE_PATTERN =
  /^(causal_supported|causal_not_supported|attribution|observation|inconclusive)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Fields that are always server-derived on declaration — plus every
 * material-shaped key is rejected so nothing secret can even be smuggled
 * into the top level of an experiments payload (§21 defense in depth
 * beyond the module's dimension guard).
 */
const EXPERIMENT_CREATE_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/bookkeeping.
  'experimentId',
  'clientId',
  'agencyId',
  'version',
  'status',
  'lifecycleState',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Result/lifecycle authority: never caller-supplied on declaration —
  // experiments start DRAFT / undecided with a null resulting decision.
  'resultState',
  'resultingDecision',
  'concludedAt',
  'conclusion',
  // Provenance is a SERVER-DERIVED dimension — never a request field.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  // Material-shaped keys are rejected outright on the experiments surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'accessKey',
] as const;

/**
 * Fields that are always server-derived on a lifecycle transition: the
 * caller names the transition (and the conclusion payload for 'conclude'
 * ONLY — the conclusion carries the analysis RESULT, never identity or
 * provenance) — everything else is authority the platform owns.
 */
const EXPERIMENT_TRANSITION_AUTHORITY_FIELDS = [
  'experimentId',
  'clientId',
  'agencyId',
  'version',
  'status',
  'fromStatus',
  'toStatus',
  'transitionId',
  'createdAt',
  'updatedAt',
  // Lifecycle authority — the status/result columns are rewritten ONLY by
  // the module from the named transition, never from a body field.
  'resultState',
  'resultingDecision',
  'concludedAt',
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
 * DTOs reject every provenance-shaped key). Mirrors the evidence/metrics
 * routes.
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

type ValidatedExperimentCreate = {
  readonly hypothesis: string;
  readonly decisionTarget: string;
  readonly populationUnit: string;
  readonly treatment: string;
  readonly comparison: string;
  readonly assignmentMethod: string;
  readonly designType: string;
  readonly primaryMetric: Record<string, unknown>;
  readonly guardrails: Record<string, unknown>[] | undefined;
  readonly analysisMethod: string;
  readonly analysisMethodVersion: string | undefined;
  readonly expectedDirection: string | undefined;
  readonly startCriteria: string | undefined;
  readonly stopCriteria: string;
  readonly minimumEvidenceRequirement: string;
  readonly uncertaintyRepresentation: string;
  readonly workspaceId: string | undefined;
};

type ValidatedConclusion = {
  readonly resultState: string;
  readonly uncertainty: Record<string, unknown> | undefined;
  readonly assumptions: string[] | undefined;
  readonly sampleLimitations: string[] | undefined;
  readonly confounders: string[] | undefined;
  readonly resultingDecision: string | undefined;
  readonly evidenceRefs: string[] | undefined;
};

type ValidatedTransition = {
  readonly transition: string;
  readonly conclusion: ValidatedConclusion | undefined;
};

/**
 * Optional strict nested-object field: absent passes as undefined (the
 * conclusion rides ONLY the conclude transition; every other transition
 * body is transition-only).
 */
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

/** The conclusion sub-object spec (shape only; the module guards semantics). */
function conclusionSpec(): ObjectSpec<ValidatedConclusion> {
  return {
    forbiddenKeys: ['provenance', 'actor', 'recordedAt', 'experimentId', 'clientId', 'status'],
    fields: {
      resultState: stringField({ pattern: EXPERIMENT_CONCLUSION_RESULT_STATE_PATTERN }),
      uncertainty: optionalRecordField({ maxDepthKeys: 6 }),
      assumptions: optionalArrayField({
        maxItems: 50,
        item: stringField({ minLength: 1, maxLength: 1000 }),
      }),
      sampleLimitations: optionalArrayField({
        maxItems: 50,
        item: stringField({ minLength: 1, maxLength: 1000 }),
      }),
      confounders: optionalArrayField({
        maxItems: 50,
        item: stringField({ minLength: 1, maxLength: 1000 }),
      }),
      resultingDecision: optionalString({ minLength: 1, maxLength: 2000 }),
      evidenceRefs: optionalArrayField({
        maxItems: 50,
        item: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
      }),
    },
  };
}

function serializeMetricIdentity(identity: ExperimentMetricIdentity): Record<string, unknown> {
  return {
    name: identity.name,
    dimensions: identity.dimensions,
  };
}

function serializeUncertainty(uncertainty: ExperimentUncertainty | null): Record<string, unknown> {
  if (uncertainty === null) return {};
  switch (uncertainty.kind) {
    case 'interval':
      return {
        kind: uncertainty.kind,
        lower: uncertainty.lower,
        upper: uncertainty.upper,
        level: uncertainty.level,
      };
    case 'distribution':
      return { kind: uncertainty.kind, descriptor: uncertainty.descriptor };
    case 'qualitative':
      return { kind: uncertainty.kind, description: uncertainty.description };
  }
}

function serializeExperiment(record: ExperimentRecord): Record<string, unknown> {
  return {
    experimentId: record.experimentId,
    clientId: record.clientId,
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    hypothesis: record.hypothesis,
    decisionTarget: record.decisionTarget,
    populationUnit: record.populationUnit,
    treatment: record.treatment,
    comparison: record.comparison,
    assignmentMethod: record.assignmentMethod,
    designType: record.designType,
    primaryMetric: serializeMetricIdentity(record.primaryMetric),
    guardrails: record.guardrails.map(serializeMetricIdentity),
    analysisMethod: record.analysisMethod,
    ...(record.analysisMethodVersion === null
      ? {}
      : { analysisMethodVersion: record.analysisMethodVersion }),
    ...(record.expectedDirection === null
      ? {}
      : { expectedDirection: record.expectedDirection }),
    ...(record.startCriteria === null ? {} : { startCriteria: record.startCriteria }),
    stopCriteria: record.stopCriteria,
    minimumEvidenceRequirement: record.minimumEvidenceRequirement,
    uncertaintyRepresentation: record.uncertaintyRepresentation,
    status: record.status,
    resultState: record.resultState,
    ...(record.resultingDecision === null ? {} : { resultingDecision: record.resultingDecision }),
    ...(record.concludedAt === null ? {} : { concludedAt: record.concludedAt }),
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

function serializeTransition(record: ExperimentTransitionRecord): Record<string, unknown> {
  return {
    transitionId: record.transitionId,
    experimentId: record.experimentId,
    transition: record.transition,
    fromStatus: record.fromStatus,
    toStatus: record.toStatus,
    ...(record.conclusion === null
      ? {}
      : {
          conclusion: {
            resultState: record.conclusion.resultState,
            uncertainty: serializeUncertainty(record.conclusion.uncertainty),
            assumptions: record.conclusion.assumptions,
            sampleLimitations: record.conclusion.sampleLimitations,
            confounders: record.conclusion.confounders,
            ...(record.conclusion.resultingDecision === null
              ? {}
              : { resultingDecision: record.conclusion.resultingDecision }),
            evidenceRefs: record.conclusion.evidenceRefs,
          },
        }),
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

export function registerExperimentsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('experiments.api');

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

  /** Resolves the canonical experiment owner scope; 404 BEFORE dependent traversal. */
  async function experimentOwner(experimentId: string): Promise<OwnerScope> {
    const ownership = await modules.experiments.resolveExperimentOwnership(experimentId);
    if (ownership === null) {
      throw new NotFoundError('experiment', experimentId);
    }
    return {
      kind: 'experiment',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
      experimentId: ownership.scope.experimentId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/experiments — DECLARE one experiment (the
  // only creation path; the lifecycle starts DRAFT / undecided with a null
  // resulting decision). Client ownership comes from the PATH and is
  // resolved canonically BEFORE authorization; the optional workspaceId is
  // scope INPUT validated against canonical workspace ownership inside the
  // module — never an authorization. Identity, provenance, lifecycle state
  // and result state are server-derived; the caller declares the full §16
  // design payload only (the module guard validates every declared shape).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/experiments',
    defineMutationRoute<{ clientId: string }, ExperimentRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<ValidatedExperimentCreate>(ctx.request.body, {
          forbiddenKeys: EXPERIMENT_CREATE_AUTHORITY_FIELDS,
          fields: {
            hypothesis: stringField({ minLength: 1, maxLength: 2000 }),
            decisionTarget: stringField({ minLength: 1, maxLength: 2000 }),
            populationUnit: stringField({ minLength: 1, maxLength: 500 }),
            treatment: stringField({ minLength: 1, maxLength: 2000 }),
            comparison: stringField({ minLength: 1, maxLength: 2000 }),
            assignmentMethod: stringField({ minLength: 1, maxLength: 500 }),
            designType: stringField({ pattern: EXPERIMENT_DESIGN_PATTERN }),
            primaryMetric: recordField({ maxDepthKeys: 20 }),
            guardrails: optionalArrayField({
              maxItems: 20,
              item: recordField({ maxDepthKeys: 20 }),
            }),
            analysisMethod: stringField({ minLength: 1, maxLength: 500 }),
            analysisMethodVersion: optionalString({ minLength: 1, maxLength: 100 }),
            expectedDirection: optionalString({ pattern: EXPERIMENT_DIRECTION_PATTERN }),
            startCriteria: optionalString({ minLength: 1, maxLength: 2000 }),
            stopCriteria: stringField({ minLength: 1, maxLength: 2000 }),
            minimumEvidenceRequirement: stringField({ minLength: 1, maxLength: 500 }),
            uncertaintyRepresentation: stringField({
              pattern: EXPERIMENT_UNCERTAINTY_REPRESENTATION_PATTERN,
            }),
            workspaceId: optionalString({ minLength: 36, maxLength: 36 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedExperimentCreate;
        return modules.experiments.createExperiment(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId === undefined ? null : body.workspaceId,
            hypothesis: body.hypothesis,
            decisionTarget: body.decisionTarget,
            populationUnit: body.populationUnit,
            treatment: body.treatment,
            comparison: body.comparison,
            assignmentMethod: body.assignmentMethod,
            designType: body.designType as ExperimentRecord['designType'],
            // Shape entry only here; the module declaration guard validates
            // the metric identity (name + scalar dimensions + §21) fully.
            primaryMetric: body.primaryMetric as unknown as ExperimentMetricIdentity,
            guardrails: (body.guardrails ?? []) as unknown as readonly ExperimentMetricIdentity[],
            analysisMethod: body.analysisMethod,
            analysisMethodVersion:
              body.analysisMethodVersion === undefined ? null : body.analysisMethodVersion,
            expectedDirection:
              body.expectedDirection === undefined
                ? null
                : (body.expectedDirection as ExperimentRecord['expectedDirection']),
            startCriteria: body.startCriteria === undefined ? null : body.startCriteria,
            stopCriteria: body.stopCriteria,
            minimumEvidenceRequirement: body.minimumEvidenceRequirement,
            uncertaintyRepresentation: body.uncertaintyRepresentation as ExperimentRecord['uncertaintyRepresentation'],
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('experiments.experiment.declared', undefined, {
          experiment_id: ctx.result.experimentId,
          client_id: ctx.result.clientId,
          workspace_id: ctx.result.workspaceId,
          design_type: ctx.result.designType,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'experiments.experiment.declared',
          targetType: 'experiment',
          targetId: ctx.result.experimentId,
          idempotencyKey: `experiments.experiment.declared:${ctx.result.experimentId}`,
          details: {
            designType: ctx.result.designType,
            primaryMetricName: ctx.result.primaryMetric.name,
            guardrailCount: ctx.result.guardrails.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeExperiment(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/experiments — the Client's declared
  // experiments, newest first (design history stays readable forever).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/experiments',
    defineQueryRoute<{ clientId: string }, readonly ExperimentRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.experiments.listExperimentsForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          experiments: ctx.result.map(serializeExperiment),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/experiments/:experimentId — read one experiment. Cross-tenant/
  // unknown/deleted-client → uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/experiments/:experimentId',
    defineQueryRoute<{ experimentId: string }, ExperimentRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireExperimentAccess(modules, ctx.principal, ctx.params.experimentId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.experiments.resolveExperimentOwnership(
          ctx.params.experimentId,
        );
        if (ownership === null) {
          throw new NotFoundError('experiment', ctx.params.experimentId);
        }
        return ownership.experiment;
      },
      respond: (ctx) => jsonResponse(200, serializeExperiment(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/experiments/:experimentId/transitions — apply ONE lifecycle
  // transition (the frozen state machine: mark_ready, start,
  // begin_analysis, conclude, stop, invalidate). The caller names the
  // transition; the module re-validates legality against the CURRENT
  // status (409 otherwise) and appends the immutable history row. Only the
  // 'conclude' transition carries its conclusion payload (result state
  // from the closed taxonomy, the uncertainty payload matching the
  // DECLARED representation, the retained analysis metadata, the resulting
  // decision and the same-Client evidence citations). Requires
  // owner|admin|platform admin — lifecycle transitions are explicit
  // authorized operations.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/experiments/:experimentId/transitions',
    defineMutationRoute<{ experimentId: string }, ExperimentRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => experimentOwner(params.experimentId),
      authorize: async (ctx) => {
        await requireExperimentAccess(modules, ctx.principal, ctx.params.experimentId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx: PipelineContext<{ experimentId: string }>) =>
        validateObject<ValidatedTransition>(ctx.request.body, {
          forbiddenKeys: EXPERIMENT_TRANSITION_AUTHORITY_FIELDS,
          fields: {
            transition: stringField({ pattern: EXPERIMENT_TRANSITION_PATTERN }),
            conclusion: optionalObjectField(conclusionSpec()),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedTransition;
        const conclusion: ExperimentConclusion | null =
          body.conclusion === undefined
            ? null
            : {
                resultState: body.conclusion.resultState as ExperimentConclusion['resultState'],
                uncertainty:
                  body.conclusion.uncertainty === undefined
                    ? null
                    : (body.conclusion.uncertainty as unknown as ExperimentUncertainty),
                assumptions: body.conclusion.assumptions ?? [],
                sampleLimitations: body.conclusion.sampleLimitations ?? [],
                confounders: body.conclusion.confounders ?? [],
                resultingDecision:
                  body.conclusion.resultingDecision === undefined
                    ? null
                    : body.conclusion.resultingDecision,
                evidenceRefs: body.conclusion.evidenceRefs ?? [],
              };
        return modules.experiments.applyExperimentTransition(
          ctx.params.experimentId,
          {
            transition: body.transition as ExperimentTransition,
            conclusion,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('experiments.experiment.transitioned', undefined, {
          experiment_id: ctx.result.experimentId,
          client_id: ctx.result.clientId,
          transition: `→ ${ctx.result.status}`,
          status: ctx.result.status,
          result_state: ctx.result.resultState,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'experiments.experiment.transitioned',
          targetType: 'experiment',
          targetId: ctx.result.experimentId,
          // Deterministic per (experiment, resulting status): the frozen
          // state machine never repeats a status, so caller retries after
          // an audit failure converge to one audit row.
          idempotencyKey: `experiments.experiment.transitioned:${ctx.result.experimentId}:${ctx.result.status}`,
          details: {
            toStatus: ctx.result.status,
            resultState: ctx.result.resultState,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeExperiment(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/experiments/:experimentId/transitions — the append-only
  // lifecycle history, oldest first (immutable: conclusion payloads stay
  // readable verbatim forever).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/experiments/:experimentId/transitions',
    defineQueryRoute<{ experimentId: string }, readonly ExperimentTransitionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireExperimentAccess(modules, ctx.principal, ctx.params.experimentId);
      },
      execute: async (ctx) => {
        return modules.experiments.listExperimentTransitions(ctx.params.experimentId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          experimentId: ctx.params.experimentId,
          transitions: ctx.result.map(serializeTransition),
        }),
    }),
  );
}
