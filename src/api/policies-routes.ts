/**
 * /policies API routes (MKT-021 — Execution policy engine: POL-001, CRED-001
 * evaluation posture).
 *
 *   POST  /api/policies                                   declare a PLATFORM-scoped policy version (platform admin only)
 *   GET   /api/policies                                   list ACTIVE platform policy versions (platform admin only — security configuration surface)
 *   GET   /api/policies/:policyId                         read one version (platform admin for platform scope; owning-agency member otherwise; superseded history stays readable)
 *
 *   POST  /api/agencies/:agencyId/policies                declare an AGENCY-scoped policy version (owner|admin|platform admin)
 *   GET   /api/agencies/:agencyId/policies                list the agency's versions in ALL states (any active member — the append-oriented history stays visible)
 *   POST  /api/clients/:clientId/policies                 declare a CLIENT-scoped policy version (owner|admin of the owning agency|platform admin)
 *   GET   /api/clients/:clientId/policies                 list the client's versions in ALL states (any active member of the owning agency)
 *
 *   POST  /api/agencies/:agencyId/policies/evaluate       AGENCY-scoped fail-closed evaluation (any active member)
 *   POST  /api/clients/:clientId/policies/evaluate        CLIENT-scoped fail-closed evaluation (any active member of the owning agency)
 *   GET   /api/agencies/:agencyId/policy-decisions        the agency's append-only decision ledger, newest first (any active member)
 *   GET   /api/clients/:clientId/policy-decisions         the client-narrowed decision ledger (any active member of the owning agency)
 *   GET   /api/policy-decisions/:decisionId               read one decision record (member of the owning agency; uniform 404 for foreign)
 *
 * There is deliberately NO update and NO delete route: policy versions are
 * append-oriented (a new version SUPERSEDES the prior active one — the old
 * row stays queryable forever), and decision records are append-only audit
 * history.
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: declaration DTOs reject
 * identity/scope/lifecycle/provenance fields; evaluation DTOs reject
 * outcome/reason/provenance/decision-identity fields AND every
 * material-shaped key (the engine evaluates access proposals — §21).
 * Outcomes and provenance are derived server-side (implementation-contract
 * §3: "No externally supplied field may override a server-derived actor,
 * owner, provenance, policy decision...").
 *
 * Authorization follows the established hard-boundary posture: every
 * mutation route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /agencies authority, the /clients
 * canonical ownership chain), authorizes against the SAME /agencies
 * membership authority as every other scoped check (no second authorization
 * authority) and yields a UNIFORM 404 for unknown/foreign identifiers (no
 * cross-tenant oracle). The evaluation SCOPE is likewise server-derived
 * from the durable path (never from the request body).
 */

import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
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
  arrayField,
  objectField,
  optionalRecordField,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requirePlatformAdministrator, requireAgencyAccess, requireClientAccess, resolveContext } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  PolicyDecisionRecord,
  PolicyDecisionProvenance,
  PolicyRule,
  PolicyVersionRecord,
} from '../modules/policies/public.ts';

const POLICY_DIMENSION_PATTERN = /^(ai|tools|network|secrets|deployment|field|extension)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Fields always server-derived on declaration — plus every
 * material-shaped key is rejected so nothing secret can even be smuggled
 * into a policy payload (§21: the engine evaluates ACCESS PROPOSALS).
 */
const POLICY_DECLARE_AUTHORITY_FIELDS = [
  // Server-derived identity/scope/lifecycle/bookkeeping.
  'policyId',
  'scope',
  'scopeKind',
  'agencyId',
  'clientId',
  'status',
  'versionSeq',
  'version',
  'supersededAt',
  'supersededByPolicyId',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Provenance is SERVER-DERIVED — never a request field.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'evaluatedAt',
  // Material-shaped keys are rejected outright on every policies surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/**
 * Fields always server-derived on EVALUATION: the decision outcome,
 * reasons, reason codes, matched policy versions, the decision identity
 * and the whole provenance block — a caller can never supply any of them
 * (the decision is computed and recorded server-side, exactly as the
 * implementation contract §3 demands).
 */
const POLICY_EVALUATE_AUTHORITY_FIELDS = [
  // Server-derived decision identity/outcome/reasons.
  'decisionId',
  'outcome',
  'reasonCode',
  'reasons',
  'matchedPolicyVersions',
  'matchedPolicyIds',
  'enforcement',
  // Server-derived scope — never request-suppliable.
  'scope',
  'scopeKind',
  'agencyId',
  'clientId',
  // Server-derived provenance.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'evaluatedAt',
  // Material-shaped keys are rejected outright.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/**
 * The rule-level forbidden-key contract: a declared rule is exactly
 * { effect, operations, resource?, attributes?, reason } — decision-
 * shaped, provenance-shaped and material-shaped keys are rejected at the
 * rule level too.
 */
const POLICY_RULE_FORBIDDEN_INPUT_KEYS = [
  'policyId',
  'ruleId',
  'scope',
  'status',
  'outcome',
  'decisionId',
  'provenance',
  'actor',
  'correlationId',
  'causationId',
  'recordedAt',
  'evaluatedAt',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/**
 * SERVER-DERIVED provenance for HTTP evaluations: actor from the
 * authenticated principal, correlation from the ambient correlation
 * context, evaluation surface 'api'. No value in here is reachable from
 * the request body (the DTO rejects every provenance-shaped key).
 */
function serverProvenance(principal: Principal): PolicyDecisionProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Serialization (opaque, non-secret representations)
// ---------------------------------------------------------------------------

function serializePolicyVersion(record: PolicyVersionRecord): Record<string, unknown> {
  return {
    policyId: record.policyId,
    dimension: record.dimension,
    scopeKind: record.scopeKind,
    ...(record.agencyId === null ? {} : { agencyId: record.agencyId }),
    ...(record.clientId === null ? {} : { clientId: record.clientId }),
    status: record.status,
    versionSeq: record.versionSeq,
    rules: record.rules,
    description: record.description,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    ...(record.supersededAt === null ? {} : { supersededAt: record.supersededAt }),
    ...(record.supersededByPolicyId === null ? {} : { supersededByPolicyId: record.supersededByPolicyId }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeDecision(record: PolicyDecisionRecord): Record<string, unknown> {
  return {
    decisionId: record.decisionId,
    dimension: record.dimension,
    agencyId: record.agencyId,
    ...(record.clientId === null ? {} : { clientId: record.clientId }),
    outcome: record.outcome,
    reasonCode: record.reasonCode,
    reasons: record.reasons,
    action: {
      dimension: record.action.dimension,
      operation: record.action.operation,
      ...(record.action.resource === null ? {} : { resource: record.action.resource }),
      attributes: record.action.attributes,
    },
    matchedPolicyVersions: record.matchedPolicyVersions,
    enforcement: record.outcome === 'allow' ? 'allow' : 'deny',
    provenance: {
      actor: record.provenance.actor,
      recordedVia: record.provenance.recordedVia,
      correlationId: record.provenance.correlationId,
      ...(record.provenance.causationId === null
        ? {}
        : { causationId: record.provenance.causationId }),
      recordedAt: record.provenance.recordedAt,
      evaluatedAt: record.provenance.evaluatedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPoliciesRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('policies.api');

  /** Canonical agency owner scope; 404 BEFORE dependent traversal. */
  async function agencyOwner(agencyId: string): Promise<OwnerScope> {
    const agency = await modules.agencies.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    return { kind: 'agency', agencyId };
  }

  /** Canonical client owner scope (agency derived from durable ownership); 404 BEFORE dependent traversal. */
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
   * The shared declaration DTO spec: the frozen POL-001 field contract —
   * dimension (closed 7-value set), bounded rules (each exactly the rule
   * contract with the rule-level forbidden-key set) and the description.
   * Identity, scope, lifecycle and provenance are all server-derived.
   */
  function declarationSpec() {
    return {
      forbiddenKeys: POLICY_DECLARE_AUTHORITY_FIELDS,
      fields: {
        dimension: stringField({ pattern: POLICY_DIMENSION_PATTERN }),
        rules: arrayField({
          minItems: 1,
          maxItems: 64,
          item: objectField({
            forbiddenKeys: POLICY_RULE_FORBIDDEN_INPUT_KEYS,
            fields: {
              effect: stringField({ pattern: /^(allow|deny)$/ }),
              operations: arrayField({
                minItems: 1,
                maxItems: 32,
                item: stringField({ minLength: 1, maxLength: 64 }),
              }),
              resource: optionalString({ minLength: 1, maxLength: 256 }),
              attributes: optionalRecordField({ maxDepthKeys: 16 }),
              reason: stringField({ minLength: 1, maxLength: 512 }),
            },
          }),
        }),
        description: stringField({ minLength: 1, maxLength: 2000 }),
      },
    };
  }

  /**
   * The evaluation DTO spec: the action descriptor only — dimension
   * (closed set), operation, optional resource (for the secrets dimension
   * the CREDENTIAL REFERENCE id) and bounded attributes. Credential-shaped
   * authority attributes are rejected at the module boundary; outcome,
   * reasons and provenance are server-derived (never request fields).
   */
  const evaluationSpec = {
    forbiddenKeys: POLICY_EVALUATE_AUTHORITY_FIELDS,
    fields: {
      dimension: stringField({ pattern: POLICY_DIMENSION_PATTERN }),
      operation: stringField({ minLength: 1, maxLength: 64 }),
      resource: optionalString({ minLength: 1, maxLength: 256 }),
      attributes: optionalRecordField({ maxDepthKeys: 16 }),
    },
  };

  type ValidatedDeclaration = {
    readonly dimension: string;
    readonly rules: ReadonlyArray<{
      readonly effect: string;
      readonly operations: readonly string[];
      readonly resource: string | undefined;
      readonly attributes: Record<string, unknown> | undefined;
      readonly reason: string;
    }>;
    readonly description: string;
  };

  type ValidatedEvaluation = {
    readonly dimension: string;
    readonly operation: string;
    readonly resource: string | undefined;
    readonly attributes: Record<string, unknown> | undefined;
  };

  /** Normalizes a validated declaration DTO into the module input rules. */
  function toRules(body: ValidatedDeclaration): readonly PolicyRule[] {
    return body.rules.map((rule) => ({
      effect: rule.effect as PolicyRule['effect'],
      operations: rule.operations,
      resource: rule.resource === undefined ? null : rule.resource,
      attributes: (rule.attributes ?? {}) as Record<string, string>,
      reason: rule.reason,
    }));
  }

  // -------------------------------------------------------------------------
  // PLATFORM-scoped policy administration (platform defaults)
  // -------------------------------------------------------------------------

  // POST /api/policies — declare a PLATFORM-scoped policy version (the
  // platform-default boundaries; platform admin only). A declaration of a
  // dimension with an ACTIVE platform version SUPERSEDES it in the same
  // transaction — the old version stays queryable forever.
  router.add(
    'POST',
    '/api/policies',
    defineMutationRoute<Record<string, string>, PolicyVersionRecord>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) => validateObject<ValidatedDeclaration>(ctx.request.body, declarationSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration;
        return modules.policies.declarePolicyVersion({
          // Platform scope is SERVER-DERIVED here — a request can never
          // select the scope; the path IS the platform surface.
          scope: { agencyId: null, clientId: null },
          dimension: body.dimension as PolicyVersionRecord['dimension'],
          rules: toRules(body),
          description: body.description,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('policies.version.declared', undefined, {
          policy_id: ctx.result.policyId,
          dimension: ctx.result.dimension,
          scope_kind: ctx.result.scopeKind,
          version_seq: ctx.result.versionSeq,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'policies.version.declared',
          targetType: 'policy_version',
          targetId: ctx.result.policyId,
          idempotencyKey: `policies.version.declared:${ctx.result.policyId}`,
          details: {
            dimension: ctx.result.dimension,
            scopeKind: ctx.result.scopeKind,
            versionSeq: ctx.result.versionSeq,
            status: ctx.result.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializePolicyVersion(ctx.result)),
    }),
  );

  // GET /api/policies — the ACTIVE platform policy versions (platform
  // admin only: the security-configuration surface; superseded history
  // stays readable by version id).
  router.add(
    'GET',
    '/api/policies',
    defineQueryRoute<Record<string, string>, readonly PolicyVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      execute: async () => {
        return modules.policies.listPolicyVersions({
          scope: { agencyId: null, clientId: null },
          dimension: null,
          includeSuperseded: false,
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          scopeKind: 'platform',
          policies: ctx.result.map(serializePolicyVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // AGENCY-scoped policy administration
  // -------------------------------------------------------------------------

  // POST /api/agencies/:agencyId/policies — declare an AGENCY-scoped policy
  // version (the Agency's own boundaries; owner|admin|platform admin).
  router.add(
    'POST',
    '/api/agencies/:agencyId/policies',
    defineMutationRoute<{ agencyId: string }, PolicyVersionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => validateObject<ValidatedDeclaration>(ctx.request.body, declarationSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration;
        return modules.policies.declarePolicyVersion({
          // Agency scope is SERVER-DERIVED from the durable path — the
          // canonical owner resolved BEFORE authorize/validate/execute.
          scope: { agencyId: ctx.params.agencyId, clientId: null },
          dimension: body.dimension as PolicyVersionRecord['dimension'],
          rules: toRules(body),
          description: body.description,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('policies.version.declared', undefined, {
          policy_id: ctx.result.policyId,
          dimension: ctx.result.dimension,
          scope_kind: ctx.result.scopeKind,
          agency_id: ctx.params.agencyId,
          version_seq: ctx.result.versionSeq,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'policies.version.declared',
          targetType: 'policy_version',
          targetId: ctx.result.policyId,
          idempotencyKey: `policies.version.declared:${ctx.result.policyId}`,
          details: {
            dimension: ctx.result.dimension,
            scopeKind: ctx.result.scopeKind,
            versionSeq: ctx.result.versionSeq,
            status: ctx.result.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializePolicyVersion(ctx.result)),
    }),
  );

  // GET /api/agencies/:agencyId/policies — the agency's declared versions
  // in ALL states (any active member — the append-oriented supersession
  // history stays visible).
  router.add(
    'GET',
    '/api/agencies/:agencyId/policies',
    defineQueryRoute<{ agencyId: string }, readonly PolicyVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.policies.listPolicyVersions({
          scope: { agencyId: ctx.params.agencyId, clientId: null },
          dimension: null,
          includeSuperseded: true,
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          policies: ctx.result.map(serializePolicyVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // CLIENT-scoped policy administration (the hard security boundary)
  // -------------------------------------------------------------------------

  // POST /api/clients/:clientId/policies — declare a CLIENT-scoped policy
  // version (owner|admin of the OWNING agency|platform admin; the scope
  // chain client → agency resolves canonically BEFORE anything else).
  router.add(
    'POST',
    '/api/clients/:clientId/policies',
    defineMutationRoute<{ clientId: string }, PolicyVersionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => validateObject<ValidatedDeclaration>(ctx.request.body, declarationSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration;
        // The owning agency is re-derived from the canonical owner INSIDE
        // the module through the /clients public contract.
        return modules.policies.declarePolicyVersion({
          scope: { agencyId: ctx.owner.kind === 'client' ? ctx.owner.agencyId : null, clientId: ctx.params.clientId },
          dimension: body.dimension as PolicyVersionRecord['dimension'],
          rules: toRules(body),
          description: body.description,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('policies.version.declared', undefined, {
          policy_id: ctx.result.policyId,
          dimension: ctx.result.dimension,
          scope_kind: ctx.result.scopeKind,
          agency_id: ctx.result.agencyId,
          client_id: ctx.params.clientId,
          version_seq: ctx.result.versionSeq,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'policies.version.declared',
          targetType: 'policy_version',
          targetId: ctx.result.policyId,
          idempotencyKey: `policies.version.declared:${ctx.result.policyId}`,
          details: {
            dimension: ctx.result.dimension,
            scopeKind: ctx.result.scopeKind,
            versionSeq: ctx.result.versionSeq,
            status: ctx.result.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializePolicyVersion(ctx.result)),
    }),
  );

  // GET /api/clients/:clientId/policies — the client's declared versions
  // in ALL states (any active member of the owning agency; foreign clients
  // are a uniform 404).
  router.add(
    'GET',
    '/api/clients/:clientId/policies',
    defineQueryRoute<{ clientId: string }, readonly PolicyVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        // Re-derive the owning agency from durable state INSIDE execute —
        // never trust the earlier pipeline resolution.
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        return modules.policies.listPolicyVersions({
          scope: { agencyId: ownership.client.agencyId, clientId: ctx.params.clientId },
          dimension: null,
          includeSuperseded: true,
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          policies: ctx.result.map(serializePolicyVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // Version reads (superseded history stays readable)
  // -------------------------------------------------------------------------

  // GET /api/policies/:policyId — read one version. Platform-scope rows
  // require the platform administrator; agency/client rows authorize
  // against the OWNING agency's membership chain (uniform 404 for foreign
  // identifiers — a policy id is never an authorization credential).
  router.add(
    'GET',
    '/api/policies/:policyId',
    defineQueryRoute<{ policyId: string }, PolicyVersionRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const policy = await modules.policies.getPolicyVersion(ctx.params.policyId);
        if (policy === null) {
          throw new NotFoundError('policy version', ctx.params.policyId);
        }
        if (policy.scopeKind === 'platform') {
          await requirePlatformAdministrator(modules, ctx.principal);
          return;
        }
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
        if (context.platformRoles.includes('platform_administrator')) return;
        const membership = context.memberships.find((entry) => entry.agencyId === policy.agencyId);
        if (membership === undefined) {
          // Hard boundary: not a member of the owning agency → the same 404
          // as an unknown policy (uniform, no cross-tenant oracle).
          throw new NotFoundError('policy version', ctx.params.policyId);
        }
        if (membership.membershipStatus !== 'active') {
          throw new ForbiddenError('Active membership in the owning agency required');
        }
      },
      execute: async (ctx) => {
        const policy = await modules.policies.getPolicyVersion(ctx.params.policyId);
        if (policy === null) {
          throw new NotFoundError('policy version', ctx.params.policyId);
        }
        return policy;
      },
      respond: (ctx) => jsonResponse(200, serializePolicyVersion(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // FAIL-CLOSED evaluation (the decision surface — POL-001 acceptance)
  // -------------------------------------------------------------------------

  // POST /api/agencies/:agencyId/policies/evaluate — agency-scoped
  // evaluation: the decision is computed against the platform + agency
  // scope chain, recorded append-only, and returned. Only outcome 'allow'
  // permits (the response carries the enforcement answer); every other
  // outcome DENIES — fail-closed.
  router.add(
    'POST',
    '/api/agencies/:agencyId/policies/evaluate',
    defineMutationRoute<{ agencyId: string }, PolicyDecisionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      validate: (ctx) => validateObject<ValidatedEvaluation>(ctx.request.body, evaluationSpec),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedEvaluation;
        return modules.policies.evaluateAction(
          {
            action: {
              dimension: body.dimension as PolicyDecisionRecord['dimension'],
              operation: body.operation,
              resource: body.resource === undefined ? null : body.resource,
              attributes: (body.attributes ?? {}) as Record<string, string>,
            },
            // The evaluation scope is SERVER-DERIVED from the durable path.
            scope: { agencyId: ctx.params.agencyId, clientId: null },
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('policies.decision.recorded', undefined, {
          decision_id: ctx.result.decisionId,
          dimension: ctx.result.dimension,
          scope_kind: 'agency',
          agency_id: ctx.params.agencyId,
          outcome: ctx.result.outcome,
          reason_code: ctx.result.reasonCode,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'policies.decision.recorded',
          targetType: 'policy_decision',
          targetId: ctx.result.decisionId,
          idempotencyKey: `policies.decision.recorded:${ctx.result.decisionId}`,
          details: {
            dimension: ctx.result.dimension,
            outcome: ctx.result.outcome,
            reasonCode: ctx.result.reasonCode,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDecision(ctx.result)),
    }),
  );

  // POST /api/clients/:clientId/policies/evaluate — client-scoped
  // evaluation: the decision is computed against the platform + agency +
  // client scope chain, recorded append-only, and returned (fail-closed:
  // only 'allow' permits).
  router.add(
    'POST',
    '/api/clients/:clientId/policies/evaluate',
    defineMutationRoute<{ clientId: string }, PolicyDecisionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) => validateObject<ValidatedEvaluation>(ctx.request.body, evaluationSpec),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedEvaluation;
        // The evaluation scope is SERVER-DERIVED from the durable ownership
        // chain (the owning agency comes from /clients canonical state,
        // re-resolved fresh here — never from the request).
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        return modules.policies.evaluateAction(
          {
            action: {
              dimension: body.dimension as PolicyDecisionRecord['dimension'],
              operation: body.operation,
              resource: body.resource === undefined ? null : body.resource,
              attributes: (body.attributes ?? {}) as Record<string, string>,
            },
            scope: { agencyId: ownership.client.agencyId, clientId: ctx.params.clientId },
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('policies.decision.recorded', undefined, {
          decision_id: ctx.result.decisionId,
          dimension: ctx.result.dimension,
          scope_kind: 'client',
          agency_id: ctx.result.agencyId,
          client_id: ctx.params.clientId,
          outcome: ctx.result.outcome,
          reason_code: ctx.result.reasonCode,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'policies.decision.recorded',
          targetType: 'policy_decision',
          targetId: ctx.result.decisionId,
          idempotencyKey: `policies.decision.recorded:${ctx.result.decisionId}`,
          details: {
            dimension: ctx.result.dimension,
            outcome: ctx.result.outcome,
            reasonCode: ctx.result.reasonCode,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDecision(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // The append-only decision ledger (audit reads)
  // -------------------------------------------------------------------------

  // GET /api/agencies/:agencyId/policy-decisions — the agency's decision
  // ledger, newest first (any active member; the append-only audit trail).
  router.add(
    'GET',
    '/api/agencies/:agencyId/policy-decisions',
    defineQueryRoute<{ agencyId: string }, readonly PolicyDecisionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.policies.listPolicyDecisions({
          agencyId: ctx.params.agencyId,
          clientId: null,
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          decisions: ctx.result.map(serializeDecision),
        }),
    }),
  );

  // GET /api/clients/:clientId/policy-decisions — the client-narrowed
  // decision ledger (any active member of the owning agency; foreign
  // clients are a uniform 404).
  router.add(
    'GET',
    '/api/clients/:clientId/policy-decisions',
    defineQueryRoute<{ clientId: string }, readonly PolicyDecisionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        return modules.policies.listPolicyDecisions({
          agencyId: ownership.client.agencyId,
          clientId: ctx.params.clientId,
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          decisions: ctx.result.map(serializeDecision),
        }),
    }),
  );

  // GET /api/policy-decisions/:decisionId — read one decision record
  // (member of the OWNING agency; uniform 404 for foreign identifiers — a
  // decision id is never an authorization credential, and cross-tenant
  // probes are indistinguishable from unknown ids).
  router.add(
    'GET',
    '/api/policy-decisions/:decisionId',
    defineQueryRoute<{ decisionId: string }, PolicyDecisionRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (!UUID_PATTERN.test(ctx.params.decisionId)) {
          throw new NotFoundError('policy decision', ctx.params.decisionId);
        }
        const decision = await modules.policies.getPolicyDecision(ctx.params.decisionId);
        if (decision === null) {
          throw new NotFoundError('policy decision', ctx.params.decisionId);
        }
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
        if (context.platformRoles.includes('platform_administrator')) return;
        const membership = context.memberships.find((entry) => entry.agencyId === decision.agencyId);
        if (membership === undefined) {
          // Hard boundary: not a member of the owning agency → the same 404
          // as an unknown decision (uniform, no cross-tenant oracle).
          throw new NotFoundError('policy decision', ctx.params.decisionId);
        }
        if (membership.membershipStatus !== 'active') {
          throw new ForbiddenError('Active membership in the owning agency required');
        }
      },
      execute: async (ctx) => {
        const decision = await modules.policies.getPolicyDecision(ctx.params.decisionId);
        if (decision === null) {
          throw new NotFoundError('policy decision', ctx.params.decisionId);
        }
        return decision;
      },
      respond: (ctx) => jsonResponse(200, serializeDecision(ctx.result)),
    }),
  );
}
