/**
 * /api/notification-delivery/* routes (MKT-068 — the Notification
 * Delivery Plane surface: the delivery command + the read surfaces).
 *
 *   POST  /api/clients/:clientId/notifications                       create + deliver (owner|admin) — claims the occurrence, runs the per-channel gates, appends the receipts (a replayed occurrence returns the honest duplicate-skipped receipts)
 *   GET   /api/clients/:clientId/notifications                      the in-app inbox view (any active member) — ?unread=true&workspaceId=… filters
 *   GET   /api/clients/:clientId/notifications/:notificationId      one notification + its full append-only receipt tail (any active member)
 *   POST  /api/clients/:clientId/notifications/:notificationId/read  the in-app read transition (any active member — append-only, exactly once)
 *   GET   /api/workspaces/:workspaceId/notifications                the workspace's in-app inbox slice (any active member)
 *
 * There is deliberately NO update route (§14 facts are immutable at
 * creation; corrections are NEW notifications), NO delete route (history
 * is append-only — the migration-047 triggers reject it at the database)
 * and NO dispatch/retry route (dispatch is part of the delivery command;
 * a retry/dispatch worker plane is future Work Item territory — the
 * receipt model already admits append-only retries).
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: the DTOs reject
 * identity/ownership/lifecycle/provenance/receipt fields AND every
 * material-shaped key (§21). The recipient set is never a request field
 * (it resolves from the workspace/client context INSIDE the module); the
 * occurrence key is the producing authority's discriminator (protocol
 * data, like the OAuth state token).
 *
 * Authorization follows the established hard-boundary posture: every
 * route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /clients chain; the notification-scoped
 * routes additionally resolve the canonical notification ownership and
 * yield a UNIFORM 404 for unknown/foreign/mismatched identifiers — no
 * cross-tenant oracle), authorizes against the SAME /agencies membership
 * authority as every other scoped check (no second authorization
 * authority), and the per-channel provider egress + credential use stay
 * behind the module's fail-closed /policies gates.
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
  NotificationInboxView,
  NotificationProvenance,
  NotificationReceiptRecord,
  NotificationRecord,
} from '../modules/notification-delivery/public.ts';
import {
  NOTIFICATION_DELIVERY_VOCABULARY_VERSION,
} from '../modules/notification-delivery/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE_PATTERN = /^(mission_attention_required|mission_terminal|execution_attention_required|deployment_attention_required|approval_required|anomaly_detected|quota_exhausted|policy_denied|system_notice)$/;
const URGENCY_PATTERN = /^(routine|important|urgent|critical)$/;
const SOURCE_KIND_PATTERN = /^(growth_mission|execution|deployment|workflow_instance|job|experiment|platform|extension)$/;
const OCCURRENCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEEP_LINK_PATTERN = /^\/[^\s:]*$/;

/**
 * Fields always server-derived on the notification-delivery surfaces —
 * plus every material-shaped key is rejected so nothing secret can even
 * be smuggled into a delivery (§21: the provider credential reaches the
 * transport through the /credentials vault at delivery time, never a
 * request field).
 */
const NOTIFICATION_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/lifecycle/outcome.
  'notificationId',
  'inboxItemId',
  'receiptId',
  'agencyId',
  'clientId',
  'deliveryStatus',
  'version',
  'receipts',
  'duplicate',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'createdAt',
  'updatedAt',
  'readAt',
  'readByActor',
  'deliveredAt',
  'providerMessageId',
  'policyDecisionId',
  'recipients',
  'recipient',
  'to',
  'email',
  'emailAddress',
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
// NOTE: `workspaceId` is deliberately NOT on the forbidden list — it is the
// OPTIONAL workspace narrowing of the delivery input (the social-accounts
// authorize-start precedent): the route validates it against canonical
// workspace ownership BEFORE the module call, so it is a validated
// selection input, never a server-authoritative value the caller could
// forge.

/**
 * SERVER-DERIVED provenance for HTTP-surface notification mutations: actor
 * from the authenticated principal, correlation from the ambient
 * correlation context, recording surface 'api'. No value in here is
 * reachable from the request body (every DTO rejects provenance-shaped
 * keys).
 */
function serverProvenance(principal: Principal): NotificationProvenance {
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
  provenance: NotificationRecord['provenance'],
): Record<string, unknown> {
  return {
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    ...(provenance.causationId === null ? {} : { causationId: provenance.causationId }),
    recordedAt: provenance.recordedAt,
  };
}

function serializeNotification(record: NotificationRecord): Record<string, unknown> {
  return {
    notificationId: record.notificationId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    eventType: record.eventType,
    urgency: record.urgency,
    explanation: record.explanation,
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    ...(record.requiredAction === null ? {} : { requiredAction: record.requiredAction }),
    deepLink: record.deepLink,
    deliveryStatus: record.deliveryStatus,
    provenance: serializeProvenance(record.provenance),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeReceipt(receipt: NotificationReceiptRecord): Record<string, unknown> {
  return {
    receiptId: receipt.receiptId,
    notificationId: receipt.notificationId,
    channel: receipt.channel,
    outcome: receipt.outcome,
    ...(receipt.providerMessageId === null
      ? {}
      : { providerMessageId: receipt.providerMessageId }),
    ...(receipt.reason === null ? {} : { reason: receipt.reason }),
    ...(receipt.policyDecisionId === null
      ? {}
      : { policyDecisionId: receipt.policyDecisionId }),
    provenance: serializeProvenance(receipt.provenance),
  };
}

function serializeInboxView(view: NotificationInboxView): Record<string, unknown> {
  return {
    inboxItemId: view.inboxItemId,
    notificationId: view.notificationId,
    readAt: view.readAt,
    ...(view.readByActor === null ? {} : { readByActor: view.readByActor }),
    deliveredAt: view.deliveredAt,
    notification: serializeNotification(view.notification),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** The validated delivery-command DTO (the strict-validation output type). */
type ValidatedDeliveryBody = {
  readonly eventType: string;
  readonly urgency: string;
  readonly explanation: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly requiredAction: string | undefined;
  readonly deepLink: string;
  readonly occurrenceKey: string;
  readonly workspaceId: string | undefined;
};

export function registerNotificationDeliveryRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('notifications.api');

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
   * The canonical NOTIFICATION owner resolution for every
   * notification-scoped route: the module resolves the record + its
   * owning chain; a notification that does not exist, or that belongs to
   * ANOTHER Client than the path's, is the SAME uniform 404 (a foreign
   * identifier is not a traversal oracle). Malformed ids are the same
   * uniform 404 (the module's UUID guard).
   */
  async function requireNotificationInClient(notificationId: string, clientId: string) {
    if (!UUID_PATTERN.test(notificationId)) {
      throw new NotFoundError('notification', notificationId);
    }
    const ownership = await modules.notificationDelivery.resolveNotificationOwnership(
      notificationId,
    );
    if (ownership === null || ownership.notification.clientId !== clientId) {
      throw new NotFoundError('notification', notificationId);
    }
    return ownership;
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/notifications — the delivery command:
  // claims the occurrence, appends the record, runs the per-channel
  // gates + adapters, appends the receipts. A replayed occurrence returns
  // the WINNING notification with the honest duplicate-skipped receipts.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/notifications',
    defineMutationRoute<
      { clientId: string },
      Awaited<ReturnType<typeof modules.notificationDelivery.deliverNotification>>
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
        validateObject<ValidatedDeliveryBody>(ctx.request.body, {
          forbiddenKeys: NOTIFICATION_AUTHORITY_FIELDS,
          fields: {
            eventType: stringField({ pattern: EVENT_TYPE_PATTERN }),
            urgency: stringField({ pattern: URGENCY_PATTERN }),
            explanation: stringField({ minLength: 1, maxLength: 2000 }),
            sourceKind: stringField({ pattern: SOURCE_KIND_PATTERN }),
            sourceId: stringField({ minLength: 1, maxLength: 256 }),
            requiredAction: optionalString({ minLength: 1, maxLength: 1000 }),
            deepLink: stringField({ pattern: DEEP_LINK_PATTERN, maxLength: 500 }),
            occurrenceKey: stringField({ pattern: OCCURRENCE_KEY_PATTERN }),
            // The OPTIONAL workspace narrowing — validated against the
            // client's workspaces by the module's DB tenant fence, but
            // resolved canonically here first (uniform 404 on foreign).
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeliveryBody;
        if (body.workspaceId !== undefined) {
          await requireWorkspaceAccess(modules, ctx.principal, body.workspaceId);
        }
        // The server-derived tenant scope (the /clients chain — never a
        // request field; the path only SELECTS which durable client gets
        // resolved).
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        type DeliveryInput = Parameters<typeof modules.notificationDelivery.deliverNotification>[0];
        return modules.notificationDelivery.deliverNotification(
          {
            agencyId: ownership.client.agencyId,
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            eventType: body.eventType as DeliveryInput['eventType'],
            urgency: body.urgency as DeliveryInput['urgency'],
            explanation: body.explanation,
            sourceKind: body.sourceKind as DeliveryInput['sourceKind'],
            sourceId: body.sourceId,
            requiredAction: body.requiredAction ?? null,
            deepLink: body.deepLink,
            occurrenceKey: body.occurrenceKey,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('notifications.delivered', undefined, {
          notification_id: ctx.result.notification.notificationId,
          client_id: ctx.params.clientId,
          duplicate: ctx.result.duplicate,
          receipts: ctx.result.receipts.map((receipt) => ({
            channel: receipt.channel,
            outcome: receipt.outcome,
          })),
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'notifications.delivered',
          targetType: 'notification',
          targetId: ctx.result.notification.notificationId,
          afterVersion: ctx.result.notification.version,
          idempotencyKey: `notifications.delivered:${ctx.result.notification.notificationId}`,
          details: {
            eventType: ctx.result.notification.eventType,
            urgency: ctx.result.notification.urgency,
            duplicate: ctx.result.duplicate,
            receiptOutcomes: [...new Set(ctx.result.receipts.map((receipt) => receipt.outcome))].join(','),
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          notification: serializeNotification(ctx.result.notification),
          receipts: ctx.result.receipts.map(serializeReceipt),
          duplicate: ctx.result.duplicate,
          vocabularyVersion: NOTIFICATION_DELIVERY_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/notifications — the IN-APP READ SURFACE
  // (the future console inbox): the client's in-app projection rows
  // joined with their notifications, newest first. Query filters: the
  // workspace slice (?workspaceId=…) and unread-only (?unread=true).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/notifications',
    defineQueryRoute<{ clientId: string }, readonly NotificationInboxView[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        const query = ctx.request.path.split('?')[1] ?? '';
        const workspaceId = new URLSearchParams(query).get('workspaceId');
        if (workspaceId !== null) {
          await requireWorkspaceAccess(modules, ctx.principal, workspaceId);
        }
        const unread = new URLSearchParams(query).get('unread');
        return modules.notificationDelivery.listInboxItems(ctx.params.clientId, {
          ...(workspaceId === null ? {} : { workspaceId }),
          ...(unread === null ? {} : { unreadOnly: unread === 'true' }),
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          inbox: ctx.result.map(serializeInboxView),
          vocabularyVersion: NOTIFICATION_DELIVERY_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/notifications/:notificationId — one
  // notification + its FULL append-only receipt tail (the honest
  // delivery history: delivered/failed/refused/duplicate-skipped
  // attempts in order).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/notifications/:notificationId',
    defineQueryRoute<
      { clientId: string; notificationId: string },
      { notification: NotificationRecord; receipts: readonly NotificationReceiptRecord[] }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        await requireNotificationInClient(ctx.params.notificationId, ctx.params.clientId);
        const notification = await modules.notificationDelivery.getNotification(
          ctx.params.notificationId,
        );
        if (notification === null) {
          throw new NotFoundError('notification', ctx.params.notificationId);
        }
        const receipts = await modules.notificationDelivery.listNotificationReceipts(
          ctx.params.notificationId,
        );
        return { notification, receipts: receipts ?? [] };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          notification: serializeNotification(ctx.result.notification),
          receipts: ctx.result.receipts.map(serializeReceipt),
          vocabularyVersion: NOTIFICATION_DELIVERY_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/notifications/:notificationId/read —
  // THE IN-APP READ TRANSITION (append-only: read_at set exactly once).
  // Any active member reads the client inbox; an already-read item is
  // the honest 409 (the transition is never re-recorded). The read state
  // is a delivery fact of the in-app projection — NEVER a task/action
  // state (boundary rule 9).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/notifications/:notificationId/read',
    defineMutationRoute<{ clientId: string; notificationId: string }, NotificationInboxView>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: NOTIFICATION_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        await requireNotificationInClient(ctx.params.notificationId, ctx.params.clientId);
        return modules.notificationDelivery.markInboxItemRead(
          { notificationId: ctx.params.notificationId },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('notifications.read', undefined, {
          notification_id: ctx.params.notificationId,
          client_id: ctx.params.clientId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'notifications.read',
          targetType: 'notification_inbox_item',
          targetId: ctx.result.inboxItemId,
          idempotencyKey: `notifications.read:${ctx.result.inboxItemId}`,
          details: {
            notificationId: ctx.params.notificationId,
            readAt: ctx.result.readAt,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInboxView(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workspaces/:workspaceId/notifications — the workspace's
  // in-app inbox slice (any active member of the owning agency).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/notifications',
    defineQueryRoute<{ workspaceId: string }, readonly NotificationInboxView[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) =>
        modules.notificationDelivery.listInboxItemsForWorkspace(ctx.params.workspaceId),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          inbox: ctx.result.map(serializeInboxView),
          vocabularyVersion: NOTIFICATION_DELIVERY_VOCABULARY_VERSION,
        }),
    }),
  );
}
