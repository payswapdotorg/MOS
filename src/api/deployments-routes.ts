/**
 * /deployments API routes (MKT-040 — Marketing Cloud Deployment control
 * plane: DEPLOY-002, the operator loop Configure → Validate → Deploy →
 * Observe → Pause/Resume → Redeploy/Rollback).
 *
 *   POST /api/workspaces/:workspaceId/deployments                                   configure (create, born DRAFT) — owner|admin of the owning agency|platform admin
 *   GET  /api/workspaces/:workspaceId/deployments                                   the Workspace's deployments (any active member)
 *   GET  /api/workspaces/:workspaceId/deployments/:deploymentId                     read one deployment (member; uniform 404 for foreign/unknown)
 *   GET  /api/workspaces/:workspaceId/deployments/:deploymentId/events              the append-only history ledger (member)
 *   POST /api/workspaces/:workspaceId/deployments/:deploymentId/validate            the compound draft→validating→ready validation (owner|admin)
 *   POST /api/workspaces/:workspaceId/deployments/:deploymentId/activate            the gated deploy/resume/redeploy/rollback completion edges (owner|admin)
 *   POST /api/workspaces/:workspaceId/deployments/:deploymentId/pause               the pause control edge (owner|admin)
 *   POST /api/workspaces/:workspaceId/deployments/:deploymentId/resume              the resume control edge (owner|admin — completes to ACTIVE through the full gate)
 *   POST /api/workspaces/:workspaceId/deployments/:deploymentId/disable             the terminal disable edge (owner|admin)
 *   POST /api/workspaces/:workspaceId/deployments/:deploymentId/block               the terminal block edge from ready (owner|admin)
 *   POST /api/workspaces/:workspaceId/deployments/:deploymentId/redeploy            request a redeploy with a NEW immutable selection (owner|admin)
 *   POST /api/workspaces/:workspaceId/deployments/:deploymentId/rollback            request a rollback to a prior ledger revision (owner|admin)
 *   POST /api/workspaces/:workspaceId/deployments/:deploymentId/request-execution   request one execution for a manual trigger (owner|admin)
 *
 * There is deliberately NO deployment delete route: deployment history is
 * append-only and the frozen lifecycle has exactly two terminal states
 * (blocked/disabled) — identifiers never replay, records never rewrite.
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: every DTO rejects
 * identity/ownership/scope/lifecycle/ledger/provenance fields AND every
 * material-shaped key (§21 — deployments reference versions and
 * capabilities, never credentials). Outcomes, validation reports,
 * provenance and the recorded history are derived server-side
 * (implementation-contract §3).
 *
 * Authorization follows the established hard-boundary posture: every
 * route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /workspaces canonical ownership chain;
 * the deployment routes additionally resolve the canonical deployment
 * owner and yield a UNIFORM 404 for unknown/foreign/mismatched
 * identifiers — no cross-tenant oracle, DEPLOY-AC-08), authorizes against
 * the SAME /agencies membership authority as every other scoped check
 * (no second authorization authority), and delegates the activation
 * gate + the fail-closed deployment-dimension policy evaluation to the
 * module (deploy/pause/resume/redeploy/rollback).
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
  arrayField,
  intField,
  objectField,
  optionalRecordField,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireWorkspaceAccess } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  DeploymentEventRecord,
  DeploymentProvenance,
  DeploymentRecord,
  DeploymentSelection,
  DeploymentTransitionOutcome,
} from '../modules/deployments/public.ts';
import { DEPLOYMENT_RUNTIME_CLASSES } from '../modules/deployments/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRIGGER_KIND_PATTERN = /^(manual|schedule|event)$/;
const CAPABILITY_KIND_PATTERN = /^(integration|extension)$/;
const RUNTIME_CLASS_PATTERN = new RegExp(`^(${DEPLOYMENT_RUNTIME_CLASSES.join('|')})$`);

/**
 * Fields always server-derived on every /deployments mutation DTO —
 * identity, ownership, scope, lifecycle, ledger outcomes and provenance —
 * plus every material-shaped key (§21).
 */
const DEPLOYMENT_AUTHORITY_FIELDS = [
  'deploymentId',
  'agencyId',
  'clientId',
  'workspaceId',
  'policyReferenceId',
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Ledger outcomes are server-recorded.
  'eventId',
  'eventType',
  'fromStatus',
  'toStatus',
  'validationReport',
  'executionRef',
  'executionId',
  'replayed',
  'event',
  'pendingSelection',
  'execution',
  // Provenance is SERVER-DERIVED — never a request field.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  // Material-shaped keys are rejected outright on every deployments surface.
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

/** The version-selection DTO spec (create + redeploy — the operator's declaration). */
function selectionSpec() {
  return objectField<Record<string, unknown>>({
    fields: {
      playbookVersionId: stringField({ pattern: UUID_PATTERN }),
      workflowDefinitionIds: arrayField({
        minItems: 1,
        maxItems: 8,
        item: stringField({ pattern: UUID_PATTERN }),
      }),
      requiredDomainPacks: arrayField({
        minItems: 0,
        maxItems: 32,
        item: objectField({
          fields: {
            name: stringField({ minLength: 1, maxLength: 128 }),
            versionConstraint: optionalString({ minLength: 1, maxLength: 64 }),
          },
        }),
      }),
      requiredCapabilities: arrayField({
        minItems: 0,
        maxItems: 32,
        item: objectField({
          fields: {
            kind: stringField({ pattern: CAPABILITY_KIND_PATTERN }),
            name: stringField({ minLength: 1, maxLength: 128 }),
            versionConstraint: optionalString({ minLength: 1, maxLength: 64 }),
          },
        }),
      }),
      runtimeRequirements: objectField({
        fields: {
          runtimeClass: stringField({ pattern: RUNTIME_CLASS_PATTERN }),
        },
      }),
      triggerConfig: arrayField({
        minItems: 1,
        maxItems: 16,
        item: objectField({
          fields: {
            kind: stringField({ pattern: TRIGGER_KIND_PATTERN }),
            config: optionalRecordField({ maxDepthKeys: 16 }),
          },
        }),
      }),
    },
  });
}

/** Normalizes a validated selection DTO into the module contract shape. */
function toSelection(dto: Record<string, unknown>): DeploymentSelection {
  const packs = (dto['requiredDomainPacks'] as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
  const capabilities = (dto['requiredCapabilities'] as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
  const triggers = (dto['triggerConfig'] as ReadonlyArray<Record<string, unknown>>) ?? [];
  const runtime = dto['runtimeRequirements'] as Record<string, unknown>;
  return {
    playbookVersionId: dto['playbookVersionId'] as string,
    workflowDefinitionIds: (dto['workflowDefinitionIds'] as readonly string[]) ?? [],
    requiredDomainPacks: packs.map((pack) => ({
      name: pack['name'] as string,
      versionConstraint: (pack['versionConstraint'] as string | undefined) ?? null,
    })),
    requiredCapabilities: capabilities.map((capability) => ({
      kind: capability['kind'] as 'integration' | 'extension',
      name: capability['name'] as string,
      versionConstraint: (capability['versionConstraint'] as string | undefined) ?? null,
    })),
    runtimeRequirements: {
      runtimeClass: runtime['runtimeClass'] as DeploymentSelection['runtimeRequirements']['runtimeClass'],
    },
    triggerConfig: triggers.map((trigger) => ({
      kind: trigger['kind'] as 'manual' | 'schedule' | 'event',
      config: (trigger['config'] as Record<string, string> | undefined) ?? null,
    })),
  };
}

/** Server-derived provenance from the authenticated principal + ambient correlation. */
function serverProvenance(principal: Principal): DeploymentProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

/** The persisted record's API serialization (the full frozen identity). */
function serializeDeployment(record: DeploymentRecord): Record<string, unknown> {
  return {
    deploymentId: record.deploymentId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    workspaceId: record.workspaceId,
    playbookVersionId: record.playbookVersionId,
    workflowDefinitionIds: record.workflowDefinitionIds,
    requiredDomainPacks: record.requiredDomainPacks,
    requiredCapabilities: record.requiredCapabilities,
    policyReferenceId: record.policyReferenceId,
    runtimeRequirements: record.runtimeRequirements,
    triggerConfig: record.triggerConfig,
    status: record.status,
    createdBy: record.createdBy,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** One ledger event's API serialization (the immutable history surface). */
function serializeEvent(event: DeploymentEventRecord): Record<string, unknown> {
  return {
    eventId: event.eventId,
    deploymentId: event.deploymentId,
    idempotencyKey: event.idempotencyKey,
    eventType: event.eventType,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    selection: event.selection,
    validationReport: event.validationReport,
    reason: event.reason,
    executionRef: event.executionRef,
    provenance: event.provenance,
  };
}

function serializeTransition(outcome: DeploymentTransitionOutcome): Record<string, unknown> {
  return {
    deployment: serializeDeployment(outcome.deployment),
    event: serializeEvent(outcome.event),
    replayed: outcome.replayed,
  };
}

export function registerDeploymentsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('deployments.api');

  /** Canonical workspace owner scope; 404 BEFORE dependent traversal. */
  async function workspaceOwner(workspaceId: string): Promise<OwnerScope> {
    const ownership = await modules.workspaces.resolveWorkspaceOwnership(workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    return {
      kind: 'workspace',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
    };
  }

  /**
   * The canonical DEPLOYMENT owner resolution for every deployment-scoped
   * route: the module resolves the deployment + its owning chain; a
   * deployment that does not exist, whose chain does not resolve, or that
   * belongs to ANOTHER Workspace than the path's is the SAME uniform 404
   * (a foreign identifier is not a traversal oracle — DEPLOY-AC-08).
   */
  async function requireDeploymentInWorkspace(deploymentId: string, workspaceId: string) {
    const ownership = await modules.deployments.resolveDeploymentOwnership(deploymentId);
    if (ownership === null || ownership.deployment.workspaceId !== workspaceId) {
      throw new NotFoundError('deployment', deploymentId);
    }
    return ownership;
  }

  /** The deployment-scoped owner scope for the pipeline + audit trail. */
  async function deploymentOwner(deploymentId: string, workspaceId: string): Promise<OwnerScope> {
    const ownership = await requireDeploymentInWorkspace(deploymentId, workspaceId);
    return {
      kind: 'workspace',
      agencyId: ownership.deployment.agencyId,
      clientId: ownership.deployment.clientId,
      workspaceId: ownership.deployment.workspaceId,
    };
  }

  // -------------------------------------------------------------------------
  // Configure (create) + reads
  // -------------------------------------------------------------------------

  // POST /api/workspaces/:workspaceId/deployments — CONFIGURE one
  // deployment (born DRAFT). The full immutable version selection is the
  // operator's declaration; the module resolves the workspace ownership,
  // the pinned published playbook version and the active workspace-owned
  // playbook-linked workflow definitions BEFORE any write.
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/deployments',
    defineMutationRoute<{ workspaceId: string }, DeploymentRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: DEPLOYMENT_AUTHORITY_FIELDS,
          fields: {
            selection: selectionSpec(),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { selection: Record<string, unknown> };
        return modules.deployments.createDeployment(
          {
            workspaceId: ctx.params.workspaceId,
            selection: toSelection(body['selection']!),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('deployments.created', undefined, {
          workspace_id: ctx.params.workspaceId,
          deployment_id: ctx.result.deploymentId,
          playbook_version_id: ctx.result.playbookVersionId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'deployments.created',
          targetType: 'deployment',
          targetId: ctx.result.deploymentId,
          afterVersion: ctx.result.version,
          idempotencyKey: `deployments.created:${ctx.result.deploymentId}`,
          details: {
            workspaceId: ctx.result.workspaceId,
            playbookVersionId: ctx.result.playbookVersionId,
            runtimeClass: ctx.result.runtimeRequirements.runtimeClass,
            status: ctx.result.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeDeployment(ctx.result)),
    }),
  );

  // GET /api/workspaces/:workspaceId/deployments — the Workspace's
  // deployments, newest first (immutable history stays visible).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/deployments',
    defineQueryRoute<{ workspaceId: string }, readonly DeploymentRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => modules.deployments.listDeploymentsForWorkspace(ctx.params.workspaceId),
      respond: (ctx) =>
        jsonResponse(200, {
          deployments: ctx.result.map(serializeDeployment),
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/deployments/:deploymentId — read one
  // deployment (uniform 404 for foreign/unknown identifiers).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/deployments/:deploymentId',
    defineQueryRoute<{ workspaceId: string; deploymentId: string }, DeploymentRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        const ownership = await requireDeploymentInWorkspace(
          ctx.params.deploymentId,
          ctx.params.workspaceId,
        );
        return ownership.deployment;
      },
      respond: (ctx) => jsonResponse(200, serializeDeployment(ctx.result)),
    }),
  );

  // GET /api/workspaces/:workspaceId/deployments/:deploymentId/events —
  // the append-only history ledger (lifecycle decisions, validation
  // reports, version-selection revisions — the rollback chain).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/deployments/:deploymentId/events',
    defineQueryRoute<
      { workspaceId: string; deploymentId: string },
      readonly DeploymentEventRecord[]
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        await requireDeploymentInWorkspace(ctx.params.deploymentId, ctx.params.workspaceId);
        return modules.deployments.getDeploymentEvents(ctx.params.deploymentId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          events: ctx.result.map(serializeEvent),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // Validate (the compound draft→validating→ready leg)
  // -------------------------------------------------------------------------

  router.add(
    'POST',
    '/api/workspaces/:workspaceId/deployments/:deploymentId/validate',
    defineMutationRoute<{ workspaceId: string; deploymentId: string }, DeploymentTransitionOutcome>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => deploymentOwner(params.deploymentId, params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: DEPLOYMENT_AUTHORITY_FIELDS,
          fields: {
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
            expectedVersion: intField({ min: 1 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { idempotencyKey: string; expectedVersion: number };
        return modules.deployments.validateDeployment(
          {
            deploymentId: ctx.params.deploymentId,
            idempotencyKey: body.idempotencyKey,
            expectedVersion: body.expectedVersion,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('deployments.validated', undefined, {
          workspace_id: ctx.params.workspaceId,
          deployment_id: ctx.params.deploymentId,
          status: ctx.result.deployment.status,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'deployments.validated',
          targetType: 'deployment',
          targetId: ctx.params.deploymentId,
          afterVersion: ctx.result.deployment.version,
          idempotencyKey: `deployments.validated:${ctx.result.event.eventId}`,
          details: {
            status: ctx.result.deployment.status,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 200, serializeTransition(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // The lifecycle transitions (one frozen edge per route)
  // -------------------------------------------------------------------------

  /** The shared transition-route builder for the simple target states. */
  function transitionRoute(
    path: string,
    to: 'active' | 'paused' | 'disabled' | 'blocked' | 'redeploying' | 'rolling_back',
    action: string,
    needsReason: boolean,
    extraSpec?: {
      readonly selection?: ReturnType<typeof selectionSpec>;
      readonly targetEventId?: boolean;
    },
  ) {
    router.add(
      'POST',
      path,
      defineMutationRoute<
        { workspaceId: string; deploymentId: string },
        DeploymentTransitionOutcome
      >({
        authenticator: services.auth,
        resolveOwner: async (_ctx, params) =>
          deploymentOwner(params.deploymentId, params.workspaceId),
        authorize: async (ctx) => {
          await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
            'agency_owner',
            'agency_admin',
          ]);
        },
        validate: (ctx) =>
          validateObject<Record<string, unknown>>(ctx.request.body, {
            forbiddenKeys: DEPLOYMENT_AUTHORITY_FIELDS,
            fields: {
              idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
              expectedVersion: intField({ min: 1 }),
              ...(needsReason
                ? { reason: stringField({ minLength: 1, maxLength: 2000 }) }
                : { reason: optionalString({ minLength: 1, maxLength: 2000 }) }),
              ...(extraSpec?.selection !== undefined
                ? { newSelection: selectionSpec() }
                : {}),
              ...(extraSpec?.targetEventId === true
                ? { targetEventId: stringField({ pattern: UUID_PATTERN }) }
                : {}),
            },
          }),
        execute: async (ctx) => {
          const body = ctx.validated as {
            idempotencyKey: string;
            expectedVersion: number;
            reason: string | undefined;
            newSelection: Record<string, unknown> | undefined;
            targetEventId: string | undefined;
          };
          return modules.deployments.transitionDeployment(
            {
              deploymentId: ctx.params.deploymentId,
              to,
              idempotencyKey: body.idempotencyKey,
              expectedVersion: body.expectedVersion,
              reason: body.reason ?? null,
              redeploySelection:
                extraSpec?.selection !== undefined && body.newSelection !== undefined
                  ? toSelection(body.newSelection)
                  : null,
              rollbackTargetEventId: extraSpec?.targetEventId === true ? body.targetEventId ?? null : null,
            },
            serverProvenance(ctx.principal),
          );
        },
        emit: async (ctx) => {
          logger.info(`deployments.${action}`, undefined, {
            workspace_id: ctx.params.workspaceId,
            deployment_id: ctx.params.deploymentId,
            status: ctx.result.deployment.status,
            replayed: ctx.result.replayed,
            correlation_id: currentCorrelation().correlationId,
          });
          await recordMutationAudit(modules, ctx.principal, ctx.owner, {
            action: `deployments.${action}`,
            targetType: 'deployment',
            targetId: ctx.params.deploymentId,
            afterVersion: ctx.result.deployment.version,
            idempotencyKey: `deployments.${action}:${ctx.result.event.eventId}`,
            details: {
              status: ctx.result.deployment.status,
              replayed: ctx.result.replayed,
            },
          });
        },
        respond: (ctx) => jsonResponse(200, serializeTransition(ctx.result)),
      }),
    );
  }

  const base = '/api/workspaces/:workspaceId/deployments/:deploymentId';
  // The gated entry into ACTIVE (deploy/resume/redeploy-completion/
  // rollback-completion — the full activation gate re-runs FRESH).
  transitionRoute(`${base}/activate`, 'active', 'activated', false);
  transitionRoute(`${base}/pause`, 'paused', 'paused', false);
  transitionRoute(`${base}/resume`, 'active', 'resumed', false);
  transitionRoute(`${base}/disable`, 'disabled', 'disabled', false);
  transitionRoute(`${base}/block`, 'blocked', 'blocked', true);
  transitionRoute(`${base}/redeploy`, 'redeploying', 'redeploy_requested', false, {
    selection: selectionSpec(),
  });
  transitionRoute(`${base}/rollback`, 'rolling_back', 'rollback_requested', false, {
    targetEventId: true,
  });

  // -------------------------------------------------------------------------
  // Request execution (the only sanctioned /executions interaction)
  // -------------------------------------------------------------------------

  router.add(
    'POST',
    `${base}/request-execution`,
    defineMutationRoute<
      { workspaceId: string; deploymentId: string },
      { deployment: DeploymentRecord; execution: { executionId: string; runtimeClass: string; replayed: boolean } }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        deploymentOwner(params.deploymentId, params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: DEPLOYMENT_AUTHORITY_FIELDS,
          fields: {
            triggerIndex: intField({ min: 0, max: 15 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { triggerIndex: number; idempotencyKey: string };
        return modules.deployments.requestDeploymentExecution(
          {
            deploymentId: ctx.params.deploymentId,
            triggerIndex: body.triggerIndex,
            idempotencyKey: body.idempotencyKey,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('deployments.execution.requested', undefined, {
          workspace_id: ctx.params.workspaceId,
          deployment_id: ctx.params.deploymentId,
          execution_id: ctx.result.execution.executionId,
          runtime_class: ctx.result.execution.runtimeClass,
          replayed: ctx.result.execution.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'deployments.execution.requested',
          targetType: 'deployment',
          targetId: ctx.params.deploymentId,
          idempotencyKey: `deployments.execution.requested:${ctx.result.execution.executionId}`,
          details: {
            executionId: ctx.result.execution.executionId,
            runtimeClass: ctx.result.execution.runtimeClass,
            replayed: ctx.result.execution.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.execution.replayed ? 200 : 201, {
          deployment: serializeDeployment(ctx.result.deployment),
          execution: ctx.result.execution,
        }),
    }),
  );
}
