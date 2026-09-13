/**
 * /decisions API routes (MKT-042 — the Decision Ledger).
 *
 *   POST /api/clients/:clientId/decisions           record one decision (any active member)
 *   GET  /api/clients/:clientId/decisions           list the Client's decisions (any active member)
 *   GET  /api/decisions/:decisionId                 read one decision (member of the OWNING agency)
 *   POST /api/decisions/:decisionId/disposition     record ONE disposition (owner|admin of the OWNING agency)
 *   POST /api/decisions/:decisionId/outcome         record the observed outcome (owner|admin of the OWNING agency)
 *   GET  /api/decisions/:decisionId/events          the append-only event tail (member of the OWNING agency)
 *
 * There is deliberately NO decision update and NO delete route: the ledger
 * is append-oriented (lock rule #5) — corrections are NEW records (the
 * predecessor link), supersession forward-links the old record to its
 * successor through the disposition state machine, and the proposal
 * payload is immutable (a DB trigger backstops it). History is never
 * rewritten, and nothing is ever erased.
 *
 * SERVER-DERIVED on every write: the decision scope (Client from the PATH,
 * canonical owner resolution BEFORE authorization; the optional Workspace
 * validated inside the module; the Agency through the /clients chain), the
 * PROPOSER (identity + role derived from the authenticated principal and
 * its durable agency membership — never a body field) and the full audit
 * provenance block (actor, correlation, recording system, recordedAt).
 * The request DTOs reject every provenance-shaped authority field, every
 * proposer-shaped field, every lifecycle-authority field (disposition,
 * successor) and every outcome-authority field — a caller can never supply
 * identity, ownership, provenance, proposer or lifecycle state.
 *
 * §8 REPLAY CONVERGENCE on every write surface: the caller-supplied logical
 * idempotency key is DB-fenced — a duplicate of the SAME logical command
 * converges (200 with the recorded state; no new rows), and a key reused
 * for a DIFFERENT payload is a 409.
 *
 * Authorization follows the established hard-boundary posture: the owning
 * Client is resolved from durable state BEFORE authorize (uniform 404 for
 * unknown/foreign identifiers — no cross-tenant oracle), and every
 * decision-scoped route resolves the canonical owner chain
 * decision → client → agency before any dependent traversal.
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
import { resolveContext, requireClientAccess, requireDecisionAccess } from './authorize.ts';
import type {
  DecisionCreateInput,
  DecisionDispositionInput,
  DecisionEventRecord,
  DecisionExpectedImpact,
  DecisionObservedOutcome,
  DecisionOutcomeInput,
  DecisionProposer,
  DecisionRecord,
  DecisionUncertainty,
} from '../modules/decisions/public.ts';

const DECISION_DISPOSITION_COMMAND_PATTERN = /^(accept|reject|supersede)$/;
// NOTE: the expected-impact direction is validated by the module guard
// (isKnownDecisionImpactDirection through assertValidDecisionCreate) — the
// create DTO accepts the structured expectedImpact record and the frozen
// closed-set direction check runs at the authority boundary.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Fields that are always server-derived on the create surface — the
 * decision identity/scope/lifecycle, the proposer, the audit block — plus
 * every material-shaped key is rejected so nothing secret can even be
 * smuggled into the top level of a decisions payload (§21 defense in
 * depth beyond the module's structured-payload guards).
 */
const DECISION_CREATE_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/bookkeeping. NOTE: workspaceId is
  // deliberately ABSENT — it is scope INPUT (the learnings/experiments
  // precedent: "workspaceId is scope INPUT validated against canonical
  // workspace ownership inside the module"), never an authorization.
  'decisionId',
  'clientId',
  'agencyId',
  'version',
  'status',
  'lifecycleState',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Lifecycle authority: never caller-supplied on the proposal — a
  // decision starts 'proposed' with no successor and no outcome.
  'disposition',
  'successorDecisionId',
  'dispositionAt',
  'observedOutcome',
  'executionRef',
  'deploymentRef',
  'learningRef',
  'outcomeAt',
  'createFingerprint',
  // The proposer is a SERVER-DERIVED dimension — never a request field.
  'proposer',
  'proposerActor',
  'proposerRole',
  'proposedBy',
  // Provenance is a SERVER-DERIVED dimension — never a request field.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  // Material-shaped keys are rejected outright on the decisions surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'accessKey',
] as const;

/**
 * Fields that are always server-derived on the disposition surface: the
 * caller names the command (and the successor for 'supersede' ONLY) —
 * everything else is authority the platform owns.
 */
const DECISION_DISPOSITION_AUTHORITY_FIELDS = [
  'decisionId',
  'clientId',
  'agencyId',
  'workspaceId',
  'version',
  'status',
  'eventId',
  'eventKind',
  'fromDisposition',
  'toDisposition',
  'createdAt',
  'updatedAt',
  'disposition',
  'dispositionAt',
  'observedOutcome',
  'executionRef',
  'deploymentRef',
  'learningRef',
  'outcomeAt',
  'proposer',
  'proposerActor',
  'proposerRole',
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
 * Fields that are always server-derived on the outcome surface: the caller
 * declares the observed outcome payload and its optional references — the
 * identity, provenance and disposition state stay platform-owned.
 */
const DECISION_OUTCOME_AUTHORITY_FIELDS = [
  'decisionId',
  'clientId',
  'agencyId',
  'workspaceId',
  'version',
  'status',
  'eventId',
  'eventKind',
  'createdAt',
  'updatedAt',
  'disposition',
  'successorDecisionId',
  'dispositionAt',
  'outcomeAt',
  'proposer',
  'proposerActor',
  'proposerRole',
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
 * DTOs reject every provenance-shaped key). Mirrors the
 * evidence/metrics/experiments/learnings routes.
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

/**
 * SERVER-DERIVED PROPOSER for the create surface: identity + role,
 * resolved from the authenticated principal and its DURABLE membership in
 * the agency that owns the record's Client (never from the request body).
 * Service principals propose as 'service'; platform administrators as
 * 'platform_administrator'; agency members with their membership role.
 */
async function serverProposer(
  modules: ApplicationModules,
  principal: Principal,
  agencyId: string,
): Promise<DecisionProposer> {
  if (principal.kind === 'service') {
    return { actor: `service:${principal.label}`, role: 'service' };
  }
  const context = await resolveContext(modules, principal);
  if (context === null) {
    throw new NotFoundError('decision', 'proposer');
  }
  if (context.platformRoles.includes('platform_administrator')) {
    return { actor: auditActor(principal), role: 'platform_administrator' };
  }
  const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
  if (membership === undefined) {
    // Unreachable behind requireClientAccess (the hard boundary already
    // rejected a non-member) — fails closed regardless.
    throw new NotFoundError('decision', 'proposer');
  }
  return { actor: auditActor(principal), role: membership.role };
}

/** Optional strict boolean field (absent passes as undefined). */
function optionalBooleanField(): FieldSpec<boolean | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'boolean') {
        problems.push('must be a boolean');
        return false;
      }
      return value;
    },
  };
}

type ValidatedDecisionCreate = {
  readonly objective: string;
  readonly context: string | undefined;
  readonly hypothesisSummary: string;
  readonly experimentRef: string | undefined;
  readonly evidenceRefs: string[] | undefined;
  readonly expectedImpact: Record<string, unknown>;
  readonly uncertainty: Record<string, unknown> | undefined;
  readonly expectedCost: string | undefined;
  readonly alternatives: string[] | undefined;
  readonly predecessorDecisionId: string | undefined;
  readonly idempotencyKey: string;
  readonly workspaceId: string | undefined;
};

type ValidatedDisposition = {
  readonly command: string;
  readonly reason: string | undefined;
  readonly successorDecisionId: string | undefined;
  readonly idempotencyKey: string;
};

type ValidatedOutcome = {
  readonly observedOutcome: Record<string, unknown>;
  readonly executionRef: string | undefined;
  readonly deploymentRef: string | undefined;
  readonly learningRef: string | undefined;
  readonly idempotencyKey: string;
};

/** The observed-outcome sub-object spec (shape only; the module guards semantics). */
function observedOutcomeSpec(): ObjectSpec<Record<string, unknown>> {
  return {
    forbiddenKeys: ['provenance', 'actor', 'recordedAt', 'decisionId', 'clientId', 'disposition'],
    fields: {
      summary: stringField({ minLength: 1, maxLength: 2000 }),
      asExpected: optionalBooleanField(),
      notes: optionalString({ minLength: 1, maxLength: 2000 }),
    },
  };
}

function serializeUncertainty(uncertainty: DecisionUncertainty | null): Record<string, unknown> {
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

function serializeDecision(record: DecisionRecord): Record<string, unknown> {
  return {
    decisionId: record.decisionId,
    clientId: record.clientId,
    agencyId: record.agencyId,
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    objective: record.objective,
    ...(record.context === null ? {} : { context: record.context }),
    hypothesisSummary: record.hypothesisSummary,
    ...(record.experimentRef === null ? {} : { experimentRef: record.experimentRef }),
    evidenceRefs: record.evidenceRefs,
    expectedImpact: {
      summary: record.expectedImpact.summary,
      ...(record.expectedImpact.direction === null
        ? {}
        : { direction: record.expectedImpact.direction }),
      ...(record.expectedImpact.magnitude === null
        ? {}
        : { magnitude: record.expectedImpact.magnitude }),
    },
    ...(record.uncertainty === null ? {} : { uncertainty: serializeUncertainty(record.uncertainty) }),
    ...(record.expectedCost === null ? {} : { expectedCost: record.expectedCost }),
    alternatives: record.alternatives,
    ...(record.predecessorDecisionId === null
      ? {}
      : { predecessorDecisionId: record.predecessorDecisionId }),
    proposer: {
      actor: record.proposer.actor,
      role: record.proposer.role,
    },
    disposition: record.disposition,
    ...(record.successorDecisionId === null
      ? {}
      : { successorDecisionId: record.successorDecisionId }),
    ...(record.dispositionAt === null ? {} : { dispositionAt: record.dispositionAt }),
    ...(record.observedOutcome === null
      ? {}
      : {
          observedOutcome: {
            summary: record.observedOutcome.summary,
            ...(record.observedOutcome.asExpected === null
              ? {}
              : { asExpected: record.observedOutcome.asExpected }),
            ...(record.observedOutcome.notes === null
              ? {}
              : { notes: record.observedOutcome.notes }),
          },
        }),
    ...(record.executionRef === null ? {} : { executionRef: record.executionRef }),
    ...(record.deploymentRef === null ? {} : { deploymentRef: record.deploymentRef }),
    ...(record.learningRef === null ? {} : { learningRef: record.learningRef }),
    ...(record.outcomeAt === null ? {} : { outcomeAt: record.outcomeAt }),
    idempotencyKey: record.idempotencyKey,
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

function serializeEvent(record: DecisionEventRecord): Record<string, unknown> {
  return {
    eventId: record.eventId,
    decisionId: record.decisionId,
    eventKind: record.eventKind,
    ...(record.disposition === null ? {} : { disposition: record.disposition }),
    ...(record.reason === null ? {} : { reason: record.reason }),
    ...(record.successorDecisionId === null
      ? {}
      : { successorDecisionId: record.successorDecisionId }),
    ...(record.observedOutcome === null
      ? {}
      : {
          observedOutcome: {
            summary: record.observedOutcome.summary,
            ...(record.observedOutcome.asExpected === null
              ? {}
              : { asExpected: record.observedOutcome.asExpected }),
            ...(record.observedOutcome.notes === null
              ? {}
              : { notes: record.observedOutcome.notes }),
          },
        }),
    ...(record.executionRef === null ? {} : { executionRef: record.executionRef }),
    ...(record.deploymentRef === null ? {} : { deploymentRef: record.deploymentRef }),
    ...(record.learningRef === null ? {} : { learningRef: record.learningRef }),
    idempotencyKey: record.idempotencyKey,
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

export function registerDecisionsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('decisions.api');

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

  /** Resolves the canonical decision owner scope; 404 BEFORE dependent traversal. */
  async function decisionOwner(decisionId: string): Promise<OwnerScope> {
    const ownership = await modules.decisions.resolveDecisionOwnership(decisionId);
    if (ownership === null) {
      throw new NotFoundError('decision', decisionId);
    }
    return {
      kind: 'decision',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
      decisionId: ownership.scope.decisionId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/decisions — RECORD one decision (the only
  // creation path; the lifecycle starts 'proposed' with no successor and
  // no outcome). Client ownership comes from the PATH and is resolved
  // canonically BEFORE authorization; the optional workspaceId is scope
  // INPUT validated against canonical workspace ownership inside the
  // module — never an authorization. Identity, scope, proposer,
  // provenance, lifecycle and outcome state are server-derived; the
  // caller declares the full proposal vocabulary only (the module guard
  // validates every declared shape, and the write-time reference
  // validation runs through the cited authorities' public contracts).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/decisions',
    defineMutationRoute<{ clientId: string }, { decision: DecisionRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<ValidatedDecisionCreate>(ctx.request.body, {
          forbiddenKeys: DECISION_CREATE_AUTHORITY_FIELDS,
          fields: {
            objective: stringField({ minLength: 1, maxLength: 2000 }),
            context: optionalString({ minLength: 1, maxLength: 2000 }),
            hypothesisSummary: stringField({ minLength: 1, maxLength: 2000 }),
            experimentRef: optionalString({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            evidenceRefs: optionalArrayField({
              maxItems: 50,
              item: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            }),
            expectedImpact: recordField({ maxDepthKeys: 8 }),
            uncertainty: optionalRecordField({ maxDepthKeys: 8 }),
            expectedCost: optionalString({ minLength: 1, maxLength: 2000 }),
            alternatives: optionalArrayField({
              maxItems: 20,
              item: stringField({ minLength: 1, maxLength: 1000 }),
            }),
            predecessorDecisionId: optionalString({
              minLength: 36,
              maxLength: 36,
              pattern: UUID_PATTERN,
            }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
            workspaceId: optionalString({ minLength: 36, maxLength: 36 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDecisionCreate;
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        // The SERVER-DERIVED proposer: identity + durable membership role
        // in the OWNING agency (never a body field).
        const proposer = await serverProposer(modules, ctx.principal, ownership.client.agencyId);
        const input: DecisionCreateInput = {
          clientId: ctx.params.clientId,
          workspaceId: body.workspaceId === undefined ? null : body.workspaceId,
          objective: body.objective,
          context: body.context === undefined ? null : body.context,
          hypothesisSummary: body.hypothesisSummary,
          experimentRef: body.experimentRef === undefined ? null : body.experimentRef,
          evidenceRefs: body.evidenceRefs ?? [],
          // Shape entry only here; the module guard validates the
          // structured payload fully (summary/direction/magnitude).
          expectedImpact: body.expectedImpact as unknown as DecisionExpectedImpact,
          uncertainty:
            body.uncertainty === undefined
              ? null
              : (body.uncertainty as unknown as DecisionUncertainty),
          expectedCost: body.expectedCost === undefined ? null : body.expectedCost,
          alternatives: body.alternatives ?? [],
          predecessorDecisionId:
            body.predecessorDecisionId === undefined ? null : body.predecessorDecisionId,
          idempotencyKey: body.idempotencyKey,
        };
        return modules.decisions.createDecision(input, proposer, serverProvenance(ctx.principal));
      },
      emit: async (ctx) => {
        logger.info('decisions.decision.recorded', undefined, {
          decision_id: ctx.result.decision.decisionId,
          client_id: ctx.result.decision.clientId,
          workspace_id: ctx.result.decision.workspaceId,
          disposition: ctx.result.decision.disposition,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'decisions.decision.recorded',
          targetType: 'decision',
          targetId: ctx.result.decision.decisionId,
          // Deterministic per decision id: a §8 replay converges to the
          // one audit row (the audit ledger's own idempotency fence).
          idempotencyKey: `decisions.decision.recorded:${ctx.result.decision.decisionId}`,
          details: {
            disposition: ctx.result.decision.disposition,
            evidenceRefCount: ctx.result.decision.evidenceRefs.length,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          replayed: ctx.result.replayed,
          decision: serializeDecision(ctx.result.decision),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/decisions — the Client's recorded
  // decisions, newest first (ledger history stays readable forever).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/decisions',
    defineQueryRoute<{ clientId: string }, readonly DecisionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.decisions.listDecisionsForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          decisions: ctx.result.map(serializeDecision),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/decisions/:decisionId — read one decision. Cross-tenant/
  // unknown/deleted-client → uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/decisions/:decisionId',
    defineQueryRoute<{ decisionId: string }, DecisionRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireDecisionAccess(modules, ctx.principal, ctx.params.decisionId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.decisions.resolveDecisionOwnership(
          ctx.params.decisionId,
        );
        if (ownership === null) {
          throw new NotFoundError('decision', ctx.params.decisionId);
        }
        return ownership.decision;
      },
      respond: (ctx) => jsonResponse(200, serializeDecision(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/decisions/:decisionId/disposition — record ONE disposition
  // (the frozen state machine: accept / reject / supersede from 'proposed'
  // only). The caller names the command; the module re-validates legality
  // against the CURRENT disposition (409 otherwise — terminal history
  // never rewrites), the successor consistency for 'supersede' (a live
  // same-Client correction of THIS decision) and appends the immutable
  // event row. Requires owner|admin|platform admin — dispositions are the
  // consequential governance act.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/decisions/:decisionId/disposition',
    defineMutationRoute<
      { decisionId: string },
      { decision: DecisionRecord; event: DecisionEventRecord; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => decisionOwner(params.decisionId),
      authorize: async (ctx) => {
        await requireDecisionAccess(modules, ctx.principal, ctx.params.decisionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedDisposition>(ctx.request.body, {
          forbiddenKeys: DECISION_DISPOSITION_AUTHORITY_FIELDS,
          fields: {
            command: stringField({ pattern: DECISION_DISPOSITION_COMMAND_PATTERN }),
            reason: optionalString({ minLength: 1, maxLength: 2000 }),
            successorDecisionId: optionalString({
              minLength: 36,
              maxLength: 36,
              pattern: UUID_PATTERN,
            }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDisposition;
        const input: DecisionDispositionInput = {
          command: body.command as DecisionDispositionInput['command'],
          reason: body.reason === undefined ? null : body.reason,
          successorDecisionId:
            body.successorDecisionId === undefined ? null : body.successorDecisionId,
          idempotencyKey: body.idempotencyKey,
        };
        return modules.decisions.recordDecisionDisposition(
          ctx.params.decisionId,
          input,
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('decisions.decision.dispositioned', undefined, {
          decision_id: ctx.result.decision.decisionId,
          client_id: ctx.result.decision.clientId,
          disposition: ctx.result.decision.disposition,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'decisions.decision.dispositioned',
          targetType: 'decision',
          targetId: ctx.result.decision.decisionId,
          // Deterministic per (decision, resulting disposition): the
          // frozen state machine never repeats a disposition, so caller
          // retries after an audit failure converge to one audit row.
          idempotencyKey: `decisions.decision.dispositioned:${ctx.result.decision.decisionId}:${ctx.result.decision.disposition}`,
          details: {
            disposition: ctx.result.decision.disposition,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          replayed: ctx.result.replayed,
          decision: serializeDecision(ctx.result.decision),
          event: serializeEvent(ctx.result.event),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/decisions/:decisionId/outcome — record the OBSERVED OUTCOME
  // of an accepted decision (exactly once: requires 'accepted', 409
  // otherwise; a second observation is a 409 — a corrected outcome is a
  // NEW decision). Carries the structured observation plus the optional
  // execution/deployment reference (at most ONE of the two) and the
  // optional derived-learning reference — all write-time validated
  // through the cited authorities' public contracts. Requires
  // owner|admin|platform admin — the outcome closes the decision's
  // lifecycle record.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/decisions/:decisionId/outcome',
    defineMutationRoute<
      { decisionId: string },
      { decision: DecisionRecord; event: DecisionEventRecord; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => decisionOwner(params.decisionId),
      authorize: async (ctx) => {
        await requireDecisionAccess(modules, ctx.principal, ctx.params.decisionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedOutcome>(ctx.request.body, {
          forbiddenKeys: DECISION_OUTCOME_AUTHORITY_FIELDS,
          fields: {
            observedOutcome: objectField(observedOutcomeSpec()),
            executionRef: optionalString({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            deploymentRef: optionalString({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            learningRef: optionalString({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedOutcome;
        const input: DecisionOutcomeInput = {
          observedOutcome: body.observedOutcome as unknown as DecisionObservedOutcome,
          executionRef: body.executionRef === undefined ? null : body.executionRef,
          deploymentRef: body.deploymentRef === undefined ? null : body.deploymentRef,
          learningRef: body.learningRef === undefined ? null : body.learningRef,
          idempotencyKey: body.idempotencyKey,
        };
        return modules.decisions.recordObservedOutcome(
          ctx.params.decisionId,
          input,
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('decisions.decision.outcome_observed', undefined, {
          decision_id: ctx.result.decision.decisionId,
          client_id: ctx.result.decision.clientId,
          as_expected: ctx.result.decision.observedOutcome?.asExpected ?? null,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'decisions.decision.outcome_observed',
          targetType: 'decision',
          targetId: ctx.result.decision.decisionId,
          // Deterministic per decision: the outcome is one-shot, so
          // caller retries after an audit failure converge to one row.
          idempotencyKey: `decisions.decision.outcome_observed:${ctx.result.decision.decisionId}`,
          details: {
            executionLinked: ctx.result.decision.executionRef !== null,
            deploymentLinked: ctx.result.decision.deploymentRef !== null,
            learningLinked: ctx.result.decision.learningRef !== null,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          replayed: ctx.result.replayed,
          decision: serializeDecision(ctx.result.decision),
          event: serializeEvent(ctx.result.event),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/decisions/:decisionId/events — the append-only ledger event
  // tail, oldest first (immutable: the disposition reasons and the
  // observed-outcome payloads stay readable verbatim forever).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/decisions/:decisionId/events',
    defineQueryRoute<{ decisionId: string }, readonly DecisionEventRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireDecisionAccess(modules, ctx.principal, ctx.params.decisionId);
      },
      execute: async (ctx) => {
        return modules.decisions.listDecisionEvents(ctx.params.decisionId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          decisionId: ctx.params.decisionId,
          events: ctx.result.map(serializeEvent),
        }),
    }),
  );
}
