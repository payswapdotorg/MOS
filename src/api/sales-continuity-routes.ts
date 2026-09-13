/**
 * /sales-continuity API routes (MKT-046 — Sales-to-Delivery Continuity).
 *
 *   POST /api/decisions/:decisionId/carry                    carry a proposal into a Playbook (owner|admin of the OWNING agency)
 *   GET  /api/decisions/:decisionId/carry                    the continuity view anchored on the proposal (any active member)
 *   POST /api/sales-continuity/carries/:carryId/deployment   carry the carried playbook into a Deployment (owner|admin)
 *   GET  /api/sales-continuity/carries/:carryId              the continuity view of one carry (any active member)
 *   GET  /api/sales-continuity/carries/:carryId/events       the append-only continuity event tail (any active member)
 *   GET  /api/clients/:clientId/sales-continuity/carries     the Client's carries (any active member)
 *   GET  /api/playbooks/:playbookId/carry                    the round-trip view: delivery side → proposal (any active member)
 *
 * There is deliberately NO carry update and NO delete route: the
 * continuity ledger is append-only with a forward-only completion ladder
 * (DB triggers backstop it). The module ORCHESTRATES the existing
 * /playbooks and /deployments creation commands — no second playbook or
 * deployment surface exists here, and the MKT-040
 * validate-before-activate gate is never invoked from this family
 * (activation stays the /deployments authority's own routes).
 *
 * SERVER-DERIVED on every write: the carry scope (the proposal anchor
 * resolves canonically through the /decisions public contract BEFORE
 * authorization; the optional goalId and the deployment target workspace
 * are scope INPUT validated inside the composed authorities — never
 * authorizations) and the full audit provenance block. The request DTOs
 * reject every provenance-shaped authority field, every
 * identity/lifecycle field and every carried-record field — a caller can
 * never supply carry identity, carried linkage, snapshot, state or
 * provenance. The carried payload itself is NEVER a request field: it is
 * derived programmatically from the proposal record (no manual
 * re-entry).
 *
 * §8 REPLAY CONVERGENCE on every write surface: the source fence (one
 * carry per proposal version) converges a re-carry to the recorded
 * outcome (200, replayed=true, NO second playbook); the logical key
 * fences reject reuse for a different command (409).
 *
 * Authorization follows the established hard-boundary posture: the owning
 * record is resolved from durable state BEFORE authorize (uniform 404 for
 * unknown/foreign identifiers — no cross-tenant oracle), and every
 * carry-scoped route resolves the canonical owner chain carry → client →
 * agency before any dependent traversal.
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
import {
  arrayField,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import { resolveContext, requireClientAccess, requireDecisionAccess, requirePlaybookAccess } from './authorize.ts';
import type {
  SalesContinuityCarryRecord,
  SalesContinuityEventRecord,
  SalesContinuityView,
} from '../modules/sales-continuity/public.ts';
import type { AgencyRoleKey } from '../modules/agencies/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Fields that are always server-derived on the carry surface — the carry
 * identity/scope/lifecycle, the source references, the carried linkage,
 * the snapshot, the audit block — plus every material-shaped key is
 * rejected outright (§21 defense in depth).
 */
const CARRY_CREATE_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/bookkeeping.
  'carryId',
  'clientId',
  'agencyId',
  'sourceWorkspaceId',
  'workspaceId',
  // The source references and the version identity are DERIVED from the
  // proposal record — never request fields.
  'sourceDecisionId',
  'sourceFingerprint',
  'source',
  'fingerprint',
  'decisionId',
  // The carried linkage and lifecycle are completion columns owned by
  // the ledger's forward-only ladder.
  'playbookId',
  'playbookVersionId',
  'versionId',
  'versionNumber',
  'carriedVersionNumber',
  'deploymentId',
  'carryState',
  'state',
  'status',
  'carriedPayload',
  'payload',
  'carried',
  'createFingerprint',
  'recordedAt',
  'createdAt',
  'updatedAt',
  // Provenance is a SERVER-DERIVED dimension — never a request field.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  // Every CONTENT field is rejected: the carried payload is DERIVED from
  // the proposal record (no manual re-entry anywhere) — the proposal
  // vocabulary and the playbook-input vocabulary never appear on a DTO.
  'objective',
  'context',
  'hypothesisSummary',
  'experimentRef',
  'evidenceRefs',
  'expectedImpact',
  'uncertainty',
  'expectedCost',
  'alternatives',
  'scope',
  'goals',
  'outcomes',
  'assumptions',
  'economics',
  'name',
  'description',
  'strategy',
  'templates',
  'deploymentMetadata',
  'requiredDomainPacks',
  'requiredCapabilities',
  'runtimeRequirements',
  'triggers',
  'triggerConfig',
  // Material-shaped keys are rejected outright on this surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'accessKey',
] as const;

/** The deployment-carry surface: the caller names the target workspace +
 * the workflow definition references only — everything else is authority
 * the platform owns. NOTE: workspaceId is legitimate SCOPE INPUT (the
 * deployment target, validated canonically inside the module — never an
 * authorization); it is deliberately NOT forbidden here. */
const CARRY_DEPLOYMENT_AUTHORITY_FIELDS = [
  'carryId',
  'clientId',
  'agencyId',
  'playbookId',
  'playbookVersionId',
  'versionId',
  'versionNumber',
  'carriedVersionNumber',
  'deploymentId',
  'carryState',
  'state',
  'status',
  'carriedPayload',
  'payload',
  'carried',
  'selection',
  'requiredDomainPacks',
  'requiredCapabilities',
  'runtimeRequirements',
  'triggerConfig',
  'triggers',
  'createFingerprint',
  'recordedAt',
  'createdAt',
  'updatedAt',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
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
 * decisions/evidence/metrics routes.
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

// ---------------------------------------------------------------------------
// Serialization (the carry record + the continuity view + the event tail)
// ---------------------------------------------------------------------------

function serializeCarry(carry: SalesContinuityCarryRecord): Record<string, unknown> {
  return {
    carryId: carry.carryId,
    clientId: carry.clientId,
    agencyId: carry.agencyId,
    ...(carry.sourceWorkspaceId === null ? {} : { sourceWorkspaceId: carry.sourceWorkspaceId }),
    source: {
      kind: 'decision',
      decisionId: carry.sourceDecisionId,
      fingerprint: carry.sourceFingerprint,
    },
    ...(carry.carriedPlaybookId === null ? {} : { carriedPlaybookId: carry.carriedPlaybookId }),
    ...(carry.carriedPlaybookVersionId === null
      ? {}
      : { carriedPlaybookVersionId: carry.carriedPlaybookVersionId }),
    ...(carry.carriedVersionNumber === null ? {} : { carriedVersionNumber: carry.carriedVersionNumber }),
    ...(carry.carriedDeploymentId === null ? {} : { carriedDeploymentId: carry.carriedDeploymentId }),
    carryState: carry.carryState,
    carriedPayload: carry.carriedPayload,
    idempotencyKey: carry.idempotencyKey,
    provenance: {
      actor: carry.provenance.actor,
      recordedVia: carry.provenance.recordedVia,
      correlationId: carry.provenance.correlationId,
      ...(carry.provenance.causationId === null
        ? {}
        : { causationId: carry.provenance.causationId }),
      recordedAt: carry.provenance.recordedAt,
    },
  };
}

function serializeContinuityView(view: SalesContinuityView): Record<string, unknown> {
  return {
    carry: serializeCarry(view.carry),
    ...(view.source === null
      ? {}
      : { sourceDecision: { decisionId: view.source.decisionId, disposition: view.source.disposition } }),
    ...(view.playbook === null ? {} : { playbook: { playbookId: view.playbook.playbookId, name: view.playbook.name } }),
    ...(view.playbookVersion === null
      ? {}
      : {
          playbookVersion: {
            versionId: view.playbookVersion.versionId,
            playbookId: view.playbookVersion.playbookId,
            versionNumber: view.playbookVersion.versionNumber,
            status: view.playbookVersion.status,
          },
        }),
    ...(view.deployment === null
      ? {}
      : {
          deployment: {
            deploymentId: view.deployment.deploymentId,
            workspaceId: view.deployment.workspaceId,
            status: view.deployment.status,
          },
        }),
    resolvedAt: view.resolvedAt,
  };
}

function serializeEvent(event: SalesContinuityEventRecord): Record<string, unknown> {
  return {
    eventId: event.eventId,
    carryId: event.carryId,
    eventKind: event.eventKind,
    detail: event.detail,
    idempotencyKey: event.idempotencyKey,
    provenance: {
      actor: event.provenance.actor,
      recordedVia: event.provenance.recordedVia,
      correlationId: event.provenance.correlationId,
      ...(event.provenance.causationId === null ? {} : { causationId: event.provenance.causationId }),
      recordedAt: event.provenance.recordedAt,
    },
  };
}

export function registerSalesContinuityRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('sales-continuity.api');

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

  /**
   * Carry-scoped access check (the requireDecisionAccess posture, local
   * to this route family — the profit-intelligence boundary-helper
   * precedent). Step 1 resolves the CANONICAL carry ownership from
   * durable state (carry row → owning Client through the /clients chain)
   * BEFORE anything else — a tombstoned Client or an unknown identifier
   * is the uniform 404. Step 2 authorizes the caller against the agency
   * that OWNS the carry's Client: service principals and platform
   * administrators pass; a caller with NO membership in the owning
   * agency gets the SAME 404 as an unknown carry (no cross-tenant
   * oracle); a suspended membership or disabled identity is a 403;
   * `roles` optionally restricts to specific agency roles.
   */
  async function requireCarryAccess(
    principal: Principal,
    carryId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<void> {
    const ownership = await modules.salesContinuity.resolveCarryOwnership(carryId);
    if (ownership === null) {
      throw new NotFoundError('sales-continuity-carry', carryId);
    }
    if (principal.kind === 'service') return;
    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    if (context.platformRoles.includes('platform_administrator')) return;
    const membership = context.memberships.find(
      (entry) => entry.agencyId === ownership.scope.agencyId,
    );
    if (membership === undefined) {
      // Hard boundary: not a member of the OWNING agency →
      // indistinguishable from an unknown carry (uniform 404).
      throw new NotFoundError('sales-continuity-carry', carryId);
    }
    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenError('Active membership in the carry client agency required');
    }
    if (roles !== undefined && !roles.includes(membership.role)) {
      throw new ForbiddenError('This operation requires a different agency role');
    }
  }

  /** Resolves the canonical carry client owner scope; 404 BEFORE traversal. */
  async function carryOwner(carryId: string): Promise<OwnerScope> {
    const ownership = await modules.salesContinuity.resolveCarryOwnership(carryId);
    if (ownership === null) {
      throw new NotFoundError('sales-continuity-carry', carryId);
    }
    return {
      kind: 'client',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/decisions/:decisionId/carry — THE PLAYBOOK CARRY: derive
  // the structured carry payload from the proposal-shaped record (an
  // ACCEPTED decision) and create the Client-scoped Playbook + its first
  // Version THROUGH the existing /playbooks creation commands. The
  // decision anchor resolves canonically BEFORE authorization; the
  // optional goalId is scope INPUT validated by the playbook authority;
  // the carried payload is DERIVED, never accepted from the body (no
  // manual re-entry). Requires owner|admin|platform admin — the carry
  // starts the delivery path (the playbook-creation posture).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/decisions/:decisionId/carry',
    defineMutationRoute<
      { decisionId: string },
      {
        carry: SalesContinuityCarryRecord;
        playbook: { readonly playbookId: string; readonly name: string } | null;
        playbookVersion:
          | {
              readonly versionId: string;
              readonly playbookId: string;
              readonly versionNumber: number;
              readonly status: string;
            }
          | null;
        replayed: boolean;
      }
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
        parseCarryCreateBody(ctx.request.body),
      execute: async (ctx) => {
        const body = ctx.validated as { goalId: string | undefined; idempotencyKey: string };
        return modules.salesContinuity.carryProposalToPlaybook(
          {
            decisionId: ctx.params.decisionId,
            goalId: body.goalId === undefined ? null : body.goalId,
            idempotencyKey: body.idempotencyKey,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('sales_continuity.carry.playbook_carried', undefined, {
          carry_id: ctx.result.carry.carryId,
          source_decision_id: ctx.result.carry.sourceDecisionId,
          client_id: ctx.result.carry.clientId,
          playbook_id: ctx.result.carry.carriedPlaybookId,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'sales_continuity.carry.playbook_carried',
          targetType: 'sales-continuity-carry',
          targetId: ctx.result.carry.carryId,
          // Deterministic per carry id: a §8 replay converges to the one
          // audit row (the audit ledger's own idempotency fence).
          idempotencyKey: `sales-continuity.carry.playbook_carried:${ctx.result.carry.carryId}`,
          details: {
            sourceDecisionId: ctx.result.carry.sourceDecisionId,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          replayed: ctx.result.replayed,
          carry: serializeCarry(ctx.result.carry),
          ...(ctx.result.playbook === null
            ? {}
            : { playbook: { playbookId: ctx.result.playbook.playbookId, name: ctx.result.playbook.name } }),
          ...(ctx.result.playbookVersion === null
            ? {}
            : {
                playbookVersion: {
                  versionId: ctx.result.playbookVersion.versionId,
                  playbookId: ctx.result.playbookVersion.playbookId,
                  versionNumber: ctx.result.playbookVersion.versionNumber,
                  status: ctx.result.playbookVersion.status,
                },
              }),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/decisions/:decisionId/carry — the continuity view anchored
  // on the PROPOSAL: proposal → carried records (the source references,
  // the carried snapshot and the LIVE playbook/version/deployment through
  // the authorities' public contracts). An uncarried proposal is the
  // uniform 404 (no continuity to read). Any active member of the owning
  // agency.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/decisions/:decisionId/carry',
    defineQueryRoute<{ decisionId: string }, SalesContinuityView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireDecisionAccess(modules, ctx.principal, ctx.params.decisionId);
      },
      execute: async (ctx) => {
        const view = await modules.salesContinuity.getContinuityForProposal(ctx.params.decisionId);
        if (view === null) {
          // An uncarried proposal (or a foreign/unknown one) is the
          // uniform 404 — no continuity to read, no existence oracle.
          throw new NotFoundError('decision', ctx.params.decisionId);
        }
        return view;
      },
      respond: (ctx) => jsonResponse(200, serializeContinuityView(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/sales-continuity/carries/:carryId/deployment — THE
  // DEPLOYMENT CARRY ("where applicable"): completes the carried
  // playbook's path into a Deployment. The caller supplies the target
  // workspace + the workflow definition references (delivery work
  // products linked to the carried version); the version is published
  // THROUGH the frozen playbook lifecycle and the deployment is
  // configured THROUGH the existing /deployments creation command with
  // the selection DERIVED from the published version's own deployment
  // metadata. The deployment is born DRAFT — the MKT-040
  // validate-before-activate gate stays the /deployments routes' alone.
  // Requires owner|admin|platform admin (the deployment-creation
  // posture).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/sales-continuity/carries/:carryId/deployment',
    defineMutationRoute<
      { carryId: string },
      {
        carry: SalesContinuityCarryRecord;
        deployment: {
          readonly deploymentId: string;
          readonly workspaceId: string;
          readonly status: string;
          readonly playbookVersionId: string;
        };
        replayed: boolean;
      }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => carryOwner(params.carryId),
      authorize: async (ctx) => {
        await requireCarryAccess(ctx.principal, ctx.params.carryId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => parseDeploymentCarryBody(ctx.request.body),
      execute: async (ctx) => {
        const body = ctx.validated as {
          workspaceId: string;
          workflowDefinitionIds: string[];
          idempotencyKey: string;
        };
        return modules.salesContinuity.carryPlaybookToDeployment(
          {
            carryId: ctx.params.carryId,
            workspaceId: body.workspaceId,
            workflowDefinitionIds: body.workflowDefinitionIds,
            idempotencyKey: body.idempotencyKey,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('sales_continuity.carry.deployment_carried', undefined, {
          carry_id: ctx.result.carry.carryId,
          deployment_id: ctx.result.deployment.deploymentId,
          workspace_id: ctx.result.deployment.workspaceId,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'sales_continuity.carry.deployment_carried',
          targetType: 'sales-continuity-carry',
          targetId: ctx.result.carry.carryId,
          // Deterministic per carry id: the deployment leg is one-shot,
          // so caller retries converge to one audit row.
          idempotencyKey: `sales-continuity.carry.deployment_carried:${ctx.result.carry.carryId}`,
          details: {
            deploymentId: ctx.result.deployment.deploymentId,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          replayed: ctx.result.replayed,
          carry: serializeCarry(ctx.result.carry),
          deployment: {
            deploymentId: ctx.result.deployment.deploymentId,
            workspaceId: ctx.result.deployment.workspaceId,
            status: ctx.result.deployment.status,
            playbookVersionId: ctx.result.deployment.playbookVersionId,
          },
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/sales-continuity/carries/:carryId — the continuity view of
  // one carry (the provenance round-trip: source references + carried
  // snapshot + the LIVE records through the authorities' public
  // contracts). Any active member of the owning agency.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/sales-continuity/carries/:carryId',
    defineQueryRoute<{ carryId: string }, SalesContinuityView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireCarryAccess(ctx.principal, ctx.params.carryId);
      },
      execute: async (ctx) => {
        const view = await modules.salesContinuity.getContinuity(ctx.params.carryId);
        if (view === null) {
          throw new NotFoundError('sales-continuity-carry', ctx.params.carryId);
        }
        return view;
      },
      respond: (ctx) => jsonResponse(200, serializeContinuityView(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/sales-continuity/carries/:carryId/events — the append-only
  // continuity event tail, oldest first (the claim, the playbook
  // completion and the deployment completion recorded verbatim —
  // immutable linkage history). Any active member of the owning agency.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/sales-continuity/carries/:carryId/events',
    defineQueryRoute<{ carryId: string }, readonly SalesContinuityEventRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireCarryAccess(ctx.principal, ctx.params.carryId);
      },
      execute: async (ctx) => {
        return modules.salesContinuity.listCarryEvents(ctx.params.carryId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          carryId: ctx.params.carryId,
          events: ctx.result.map(serializeEvent),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/sales-continuity/carries — the Client's
  // carries, newest first (durable linkage history). Any active member of
  // the owning agency.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/sales-continuity/carries',
    defineQueryRoute<{ clientId: string }, readonly SalesContinuityCarryRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.salesContinuity.listCarriesForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          carries: ctx.result.map(serializeCarry),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/playbooks/:playbookId/carry — the ROUND-TRIP view: delivery
  // side → proposal. The playbook resolves canonically through the
  // /playbooks public contract BEFORE authorization (uniform 404 for
  // foreign/unknown); a playbook never carried is the uniform 404. Any
  // active member of the owning agency.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/playbooks/:playbookId/carry',
    defineQueryRoute<{ playbookId: string }, SalesContinuityView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requirePlaybookAccess(modules, ctx.principal, ctx.params.playbookId);
      },
      execute: async (ctx) => {
        const view = await modules.salesContinuity.getContinuityForPlaybook(ctx.params.playbookId);
        if (view === null) {
          // A playbook never carried (or a foreign/unknown one) is the
          // uniform 404 — the round-trip reads carried playbooks only.
          throw new NotFoundError('playbook', ctx.params.playbookId);
        }
        return view;
      },
      respond: (ctx) => jsonResponse(200, serializeContinuityView(ctx.result)),
    }),
  );
}

// ---------------------------------------------------------------------------
// DTO validation (shape entry only; the module guards validate semantics)
// ---------------------------------------------------------------------------

function parseCarryCreateBody(
  body: unknown,
): { goalId: string | undefined; idempotencyKey: string } {
  return validateObject<{ goalId: string | undefined; idempotencyKey: string }>(body, {
    forbiddenKeys: CARRY_CREATE_AUTHORITY_FIELDS,
    fields: {
      goalId: optionalString({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
      idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
    },
  });
}

function parseDeploymentCarryBody(
  body: unknown,
): { workspaceId: string; workflowDefinitionIds: string[]; idempotencyKey: string } {
  return validateObject<{
    workspaceId: string;
    workflowDefinitionIds: string[];
    idempotencyKey: string;
  }>(body, {
    forbiddenKeys: CARRY_DEPLOYMENT_AUTHORITY_FIELDS,
    fields: {
      workspaceId: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
      workflowDefinitionIds: arrayField({
        minItems: 1,
        maxItems: 50,
        item: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
      }),
      idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
    },
  });
}
