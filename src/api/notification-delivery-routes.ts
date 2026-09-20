/**
 * /api/agencies/:agencyId/notification-delivery/* and /api/agencies/:agencyId/notification-inbox/*
 * routes (MKT-068 — the Notification Delivery Plane HTTP surface).
 *
 *   POST /api/agencies/:agencyId/notification-delivery                                record + fan-out (owner|admin) — the §14 record is born, the per-channel pipeline runs, the receipts land
 *   GET  /api/agencies/:agencyId/notification-delivery                                the agency's records (member; ?clientId narrowing)
 *   GET  /api/agencies/:agencyId/notification-delivery/:notificationId                one record (member; uniform 404 for foreign/unknown)
 *   GET  /api/agencies/:agencyId/notification-delivery/:notificationId/receipts       the append-only receipt tail (member)
 *   POST /api/agencies/:agencyId/notification-delivery/:notificationId/redeliver      the channel retry (owner|admin) — NEW receipts, never rewrites
 *
 *   GET  /api/agencies/:agencyId/notification-inbox                                   the in-app read surface (member; ?clientId, ?unreadOnly)
 *   GET  /api/agencies/:agencyId/notification-inbox/:notificationId                   one inbox entry (member)
 *   POST /api/agencies/:agencyId/notification-inbox/:notificationId/read              the unread → read transition (member)
 *
 * There is deliberately NO update route (the §14 field set, the source
 * reference, the requested channels and the email context are immutable —
 * corrections are NEW notification records), NO delete route (the
 * delivery history is append-only; the DB rejects UPDATE/DELETE on the
 * receipt tail outright), and NO adapter-registry mutation route (adapters
 * are composition-root DATA — the registry read stays module-level for
 * server-side callers and the future console's bootstrapping).
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: the DTOs reject
 * identity/ownership/lifecycle/receipt/provenance fields AND every
 * material-shaped key (§21 — the recipient arrives as a canonical user
 * id, the provider credential as a vault REFERENCE id; the address and
 * the material NEVER appear on any surface). The email context fields
 * (recipientUserId, emailCredentialReferenceId) are delivery INTENT
 * data (the social-accounts connectionId precedent), validated by the
 * module's email payload-shape fence.
 *
 * Authorization follows the established hard-boundary posture: every
 * route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the agency row; the notification-scoped
 * routes additionally resolve the record and yield a UNIFORM 404 for
 * unknown/foreign/mismatched identifiers — no cross-tenant oracle),
 * authorizes against the SAME /agencies membership authority as every
 * other scoped check (no second authorization authority), and the
 * channel attempts stay behind the module's fail-closed /policies gates.
 */

import { NotFoundError, ForbiddenError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { AgencyRoleKey } from '../modules/agencies/public.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import { optionalString, stringField, intField, validateObject } from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { resolveContext } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  NotificationDeliveryProvenance,
  NotificationDeliveryRecord,
  NotificationDeliveryReceipt,
  NotificationInboxEntry,
} from '../modules/notification-delivery/public.ts';
import { NOTIFICATION_CHANNELS } from '../modules/notification-delivery/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fields always server-derived on the notification-delivery surfaces —
 * plus every material-shaped key is rejected so nothing secret can even
 * be smuggled into a delivery intent (§21: the provider credential is a
 * vault REFERENCE id; the recipient is a canonical user id whose address
 * resolves only through the recipient port).
 */
const NOTIFICATION_DELIVERY_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/lifecycle/outcome.
  'notificationId',
  'agencyId',
  'clientId',
  'workspaceId',
  'deliveryStatus',
  'receiptId',
  'receipts',
  'attemptSeq',
  'outcome',
  'providerMessageId',
  'policyDecisionId',
  'readStatus',
  'readAt',
  'readByActor',
  'version',
  'createdAt',
  'updatedAt',
  'notification',
  'duplicate',
  'inboxEntry',
  // Provenance is SERVER-DERIVED — never a request field.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
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
  'recipientAddress',
  'email',
  'address',
  'to',
  'subject',
  'body',
] as const;

/**
 * SERVER-DERIVED provenance for HTTP-surface notification-delivery
 * mutations: actor from the authenticated principal, correlation from
 * the ambient correlation context, recording surface 'api'. No value in
 * here is reachable from the request body (every DTO rejects
 * provenance-shaped keys).
 */
function serverProvenance(principal: Principal): NotificationDeliveryProvenance {
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

function serializeNotification(record: NotificationDeliveryRecord): Record<string, unknown> {
  return {
    notificationId: record.notificationId,
    agencyId: record.agencyId,
    ...(record.clientId === null ? {} : { clientId: record.clientId }),
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    eventType: record.eventType,
    urgency: record.urgency,
    explanation: record.explanation,
    sourceKind: record.source.kind,
    sourceId: record.source.id,
    ...(record.requiredAction === null ? {} : { requiredAction: record.requiredAction }),
    deepLink: record.deepLink,
    requestedChannels: [...record.requestedChannels],
    ...(record.recipientUserId === null ? {} : { recipientUserId: record.recipientUserId }),
    ...(record.emailCredentialReferenceId === null
      ? {}
      : { emailCredentialReferenceId: record.emailCredentialReferenceId }),
    deliveryStatus: record.deliveryStatus,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeReceipt(record: NotificationDeliveryReceipt): Record<string, unknown> {
  return {
    receiptId: record.receiptId,
    notificationId: record.notificationId,
    channel: record.channel,
    attemptSeq: record.attemptSeq,
    outcome: record.outcome,
    ...(record.reason === null ? {} : { reason: record.reason }),
    ...(record.providerMessageId === null ? {} : { providerMessageId: record.providerMessageId }),
    ...(record.policyDecisionId === null ? {} : { policyDecisionId: record.policyDecisionId }),
    recordedAt: record.recordedAt,
  };
}

function serializeInboxEntry(entry: NotificationInboxEntry): Record<string, unknown> {
  return {
    notificationId: entry.notificationId,
    agencyId: entry.agencyId,
    ...(entry.clientId === null ? {} : { clientId: entry.clientId }),
    eventType: entry.eventType,
    urgency: entry.urgency,
    explanation: entry.explanation,
    sourceKind: entry.source.kind,
    sourceId: entry.source.id,
    ...(entry.requiredAction === null ? {} : { requiredAction: entry.requiredAction }),
    deepLink: entry.deepLink,
    readStatus: entry.readStatus,
    ...(entry.readAt === null ? {} : { readAt: entry.readAt }),
    ...(entry.readByActor === null ? {} : { readByActor: entry.readByActor }),
    version: entry.version,
    createdAt: entry.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Query-parameter parsing (the app-marketplace parseListingFilters pattern)
// ---------------------------------------------------------------------------

function parseClientIdFilter(path: string): { readonly clientId: string | null } | { readonly error: string } {
  const query = path.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  if (![...params.keys()].every((key) => key === 'clientId')) {
    return { error: 'clientId: the only allowed filter' };
  }
  const clientId = params.get('clientId');
  if (clientId === null) return { clientId: null };
  if (!UUID_PATTERN.test(clientId)) {
    return { error: 'clientId: must be a canonical client UUID' };
  }
  return { clientId };
}

function parseInboxFilters(path: string): {
  readonly clientId: string | null;
  readonly unreadOnly: boolean;
} | { readonly error: string } {
  const query = path.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  if (![...params.keys()].every((key) => key === 'clientId' || key === 'unreadOnly')) {
    return { error: 'clientId, unreadOnly: the only allowed filters' };
  }
  const clientId = params.get('clientId');
  if (clientId !== null && !UUID_PATTERN.test(clientId)) {
    return { error: 'clientId: must be a canonical client UUID' };
  }
  const unreadOnlyRaw = params.get('unreadOnly');
  if (unreadOnlyRaw !== null && unreadOnlyRaw !== 'true' && unreadOnlyRaw !== 'false') {
    return { error: 'unreadOnly: must be true or false' };
  }
  return { clientId, unreadOnly: unreadOnlyRaw === 'true' };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerNotificationDeliveryRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('notification-delivery.api');

  /**
   * The agency access gate with the uniform foreign≡unknown≡malformed
   * 404 posture (the growth-missions requireGrowthMissionsAgency
   * precedent): NOT a member of the agency is the SAME 404 as an
   * unknown/malformed agency (no cross-agency existence oracle); an
   * INACTIVE (suspended) membership is the 403; the role narrowing
   * applies only to the mutation surfaces.
   */
  async function requireNotificationDeliveryAgency(
    principal: Principal,
    agencyId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<void> {
    if (!UUID_PATTERN.test(agencyId)) {
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
      // Hard boundary: not a member of the agency → the same 404 as for
      // an unknown agency (uniform, no cross-agency existence oracle).
      throw new NotFoundError('agency', agencyId);
    }
    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenError('Active membership in this agency required');
    }
    if (roles !== undefined && !roles.includes(membership.role)) {
      throw new ForbiddenError('This operation requires a different agency role');
    }
  }

  /** Canonical agency owner scope; 404 BEFORE dependent traversal (uniform for malformed/unknown). */
  async function agencyOwner(agencyId: string): Promise<OwnerScope> {
    if (!UUID_PATTERN.test(agencyId)) {
      throw new NotFoundError('agency', agencyId);
    }
    const agency = await modules.agencies.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    return { kind: 'agency', agencyId };
  }

  /**
   * The canonical notification resolution for every notification-scoped
   * route: a record that does not exist or belongs to ANOTHER agency than
   * the path's is the SAME uniform 404 (a foreign identifier is not a
   * traversal oracle).
   */
  async function requireNotificationInAgency(notificationId: string, agencyId: string) {
    if (!UUID_PATTERN.test(notificationId)) {
      throw new NotFoundError('notification', notificationId);
    }
    const record = await modules.notificationDelivery.getNotification(notificationId);
    if (record === null || record.agencyId !== agencyId) {
      throw new NotFoundError('notification', notificationId);
    }
    return record;
  }

  // -------------------------------------------------------------------------
  // The recording + fan-out surface
  // -------------------------------------------------------------------------

  // POST /api/agencies/:agencyId/notification-delivery — record the §14
  // notification and run the per-channel delivery pipeline (the receipts
  // land append-only; a replay of the same occurrence surfaces the honest
  // duplicate-skipped receipts).
  router.add(
    'POST',
    '/api/agencies/:agencyId/notification-delivery',
    defineMutationRoute<
      { agencyId: string },
      {
        notification: NotificationDeliveryRecord;
        receipts: readonly NotificationDeliveryReceipt[];
        duplicate: boolean;
      }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireNotificationDeliveryAgency(ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          eventType: string;
          urgency: string;
          explanation: string;
          sourceKind: string;
          sourceId: string;
          occurrenceKey: string;
          deepLink: string;
          channels: string[];
          requiredAction?: string;
          clientId?: string;
          workspaceId?: string;
          recipientUserId?: string;
          emailCredentialReferenceId?: string;
        }>(ctx.request.body, {
          forbiddenKeys: NOTIFICATION_DELIVERY_AUTHORITY_FIELDS,
          fields: {
            eventType: stringField({ minLength: 1, maxLength: 64 }),
            urgency: stringField({ minLength: 1, maxLength: 16 }),
            explanation: stringField({ minLength: 1, maxLength: 2000 }),
            sourceKind: stringField({ minLength: 1, maxLength: 32 }),
            sourceId: stringField({ minLength: 36, maxLength: 36 }),
            occurrenceKey: stringField({ minLength: 1, maxLength: 128 }),
            deepLink: stringField({ minLength: 1, maxLength: 1024 }),
            channels: {
              required: true,
              parse: (value, problems): string[] => {
                if (!Array.isArray(value)) {
                  problems.push('channels: an array of channel keys is required');
                  return [];
                }
                if (value.length < 1 || value.length > 6) {
                  problems.push('channels: 1..6 channel keys');
                  return [];
                }
                const seen = new Set<string>();
                for (const entry of value) {
                  if (typeof entry !== 'string' || !(NOTIFICATION_CHANNELS as readonly string[]).includes(entry)) {
                    problems.push(`channels: '${String(entry)}' is not one of the frozen channel keys (${NOTIFICATION_CHANNELS.join(', ')})`);
                    return [];
                  }
                  if (seen.has(entry)) {
                    problems.push(`channels: duplicate channel '${entry}'`);
                    return [];
                  }
                  seen.add(entry);
                }
                return value;
              },
            },
            requiredAction: optionalString({ minLength: 1, maxLength: 512 }),
            clientId: optionalString({ minLength: 36, maxLength: 36 }),
            workspaceId: optionalString({ minLength: 36, maxLength: 36 }),
            recipientUserId: optionalString({ minLength: 36, maxLength: 36 }),
            emailCredentialReferenceId: optionalString({ minLength: 36, maxLength: 36 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          eventType: string;
          urgency: string;
          explanation: string;
          sourceKind: string;
          sourceId: string;
          occurrenceKey: string;
          deepLink: string;
          channels: string[];
          requiredAction?: string;
          clientId?: string;
          workspaceId?: string;
          recipientUserId?: string;
          emailCredentialReferenceId?: string;
        };
        return modules.notificationDelivery.recordNotification(
          {
            agencyId: ctx.params.agencyId,
            clientId: body.clientId ?? null,
            workspaceId: body.workspaceId ?? null,
            eventType: body.eventType as Parameters<
              typeof modules.notificationDelivery.recordNotification
            >[0]['eventType'],
            urgency: body.urgency as Parameters<
              typeof modules.notificationDelivery.recordNotification
            >[0]['urgency'],
            explanation: body.explanation,
            source: {
              kind: body.sourceKind as Parameters<
                typeof modules.notificationDelivery.recordNotification
              >[0]['source']['kind'],
              id: body.sourceId,
            },
            occurrenceKey: body.occurrenceKey,
            requiredAction: body.requiredAction ?? null,
            deepLink: body.deepLink,
            channels: body.channels as Parameters<
              typeof modules.notificationDelivery.recordNotification
            >[0]['channels'],
            recipientUserId: body.recipientUserId ?? null,
            emailCredentialReferenceId: body.emailCredentialReferenceId ?? null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('notificationdelivery.notification.recorded', undefined, {
          notification_id: ctx.result.notification.notificationId,
          agency_id: ctx.params.agencyId,
          duplicate: ctx.result.duplicate,
          delivery_status: ctx.result.notification.deliveryStatus,
          receipts: ctx.result.receipts.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'notificationdelivery.notification.recorded',
          targetType: 'notification_record',
          targetId: ctx.result.notification.notificationId,
          afterVersion: ctx.result.notification.version,
          idempotencyKey: `notificationdelivery.recorded:${ctx.result.notification.notificationId}`,
          details: {
            eventType: ctx.result.notification.eventType,
            urgency: ctx.result.notification.urgency,
            channels: ctx.result.notification.requestedChannels.join(','),
            duplicate: ctx.result.duplicate,
            deliveryStatus: ctx.result.notification.deliveryStatus,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.duplicate ? 200 : 201, {
          notification: serializeNotification(ctx.result.notification),
          receipts: ctx.result.receipts.map(serializeReceipt),
          duplicate: ctx.result.duplicate,
        }),
    }),
  );

  // GET /api/agencies/:agencyId/notification-delivery — the agency's
  // records (optional client narrowing).
  router.add(
    'GET',
    '/api/agencies/:agencyId/notification-delivery',
    defineQueryRoute<
      { agencyId: string },
      { readonly clientId: string | null; readonly records: readonly NotificationDeliveryRecord[] }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireNotificationDeliveryAgency(ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        const filters = parseClientIdFilter(ctx.request.path);
        if ('error' in filters) {
          throw new NotFoundError('filter', filters.error);
        }
        const records = await modules.notificationDelivery.listNotificationsForAgency({
          agencyId: ctx.params.agencyId,
          clientId: filters.clientId,
        });
        return { clientId: filters.clientId, records };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          ...(ctx.result.clientId === null ? {} : { clientId: ctx.result.clientId }),
          notifications: ctx.result.records.map(serializeNotification),
        }),
    }),
  );

  // GET /api/agencies/:agencyId/notification-delivery/:notificationId —
  // one record (uniform 404 for foreign/unknown).
  router.add(
    'GET',
    '/api/agencies/:agencyId/notification-delivery/:notificationId',
    defineQueryRoute<{ agencyId: string; notificationId: string }, NotificationDeliveryRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireNotificationDeliveryAgency(ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) =>
        requireNotificationInAgency(ctx.params.notificationId, ctx.params.agencyId),
      respond: (ctx) => jsonResponse(200, serializeNotification(ctx.result)),
    }),
  );

  // GET /api/agencies/:agencyId/notification-delivery/:notificationId/receipts
  // — the append-only receipt tail (attempt order, complete history).
  router.add(
    'GET',
    '/api/agencies/:agencyId/notification-delivery/:notificationId/receipts',
    defineQueryRoute<
      { agencyId: string; notificationId: string },
      readonly NotificationDeliveryReceipt[]
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireNotificationDeliveryAgency(ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        await requireNotificationInAgency(ctx.params.notificationId, ctx.params.agencyId);
        return modules.notificationDelivery.listReceipts(ctx.params.notificationId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          notificationId: ctx.params.notificationId,
          receipts: ctx.result.map(serializeReceipt),
        }),
    }),
  );

  // POST /api/agencies/:agencyId/notification-delivery/:notificationId/redeliver
  // — the channel retry: NEW receipts, never rewrites.
  router.add(
    'POST',
    '/api/agencies/:agencyId/notification-delivery/:notificationId/redeliver',
    defineMutationRoute<
      { agencyId: string; notificationId: string },
      { notification: NotificationDeliveryRecord; receipts: readonly NotificationDeliveryReceipt[] }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireNotificationDeliveryAgency(ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ channel: string }>(ctx.request.body, {
          forbiddenKeys: NOTIFICATION_DELIVERY_AUTHORITY_FIELDS,
          fields: {
            channel: stringField({ minLength: 1, maxLength: 32 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { channel: string };
        return modules.notificationDelivery.redeliverChannel(
          {
            notificationId: ctx.params.notificationId,
            channel: body.channel as Parameters<
              typeof modules.notificationDelivery.redeliverChannel
            >[0]['channel'],
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('notificationdelivery.channel.redelivered', undefined, {
          notification_id: ctx.params.notificationId,
          agency_id: ctx.params.agencyId,
          receipts: ctx.result.receipts.length,
          delivery_status: ctx.result.notification.deliveryStatus,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'notificationdelivery.channel.redelivered',
          targetType: 'notification_record',
          targetId: ctx.params.notificationId,
          afterVersion: ctx.result.notification.version,
          idempotencyKey: `notificationdelivery.redeliver:${ctx.result.receipts[0]?.receiptId ?? ctx.params.notificationId}`,
          details: {
            deliveryStatus: ctx.result.notification.deliveryStatus,
            receipts: ctx.result.receipts.length,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          notification: serializeNotification(ctx.result.notification),
          receipts: ctx.result.receipts.map(serializeReceipt),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // The in-app read surface (the future console reads this)
  // -------------------------------------------------------------------------

  // GET /api/agencies/:agencyId/notification-inbox — the inbox projection
  // (optional client narrowing + unread-only filter).
  router.add(
    'GET',
    '/api/agencies/:agencyId/notification-inbox',
    defineQueryRoute<
      { agencyId: string },
      {
        readonly clientId: string | null;
        readonly unreadOnly: boolean;
        readonly entries: readonly NotificationInboxEntry[];
      }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireNotificationDeliveryAgency(ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        const filters = parseInboxFilters(ctx.request.path);
        if ('error' in filters) {
          throw new NotFoundError('filter', filters.error);
        }
        const entries = await modules.notificationDelivery.listInbox({
          agencyId: ctx.params.agencyId,
          clientId: filters.clientId,
          unreadOnly: filters.unreadOnly,
        });
        return { ...filters, entries };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          ...(ctx.result.clientId === null ? {} : { clientId: ctx.result.clientId }),
          unreadOnly: ctx.result.unreadOnly,
          entries: ctx.result.entries.map(serializeInboxEntry),
        }),
    }),
  );

  // GET /api/agencies/:agencyId/notification-inbox/:notificationId — one
  // inbox entry (uniform 404 for foreign/unknown/never-in-app-delivered).
  router.add(
    'GET',
    '/api/agencies/:agencyId/notification-inbox/:notificationId',
    defineQueryRoute<{ agencyId: string; notificationId: string }, NotificationInboxEntry>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireNotificationDeliveryAgency(ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        await requireNotificationInAgency(ctx.params.notificationId, ctx.params.agencyId);
        const entry = await modules.notificationDelivery.getInboxEntry(
          ctx.params.notificationId,
        );
        if (entry === null) {
          throw new NotFoundError('notification inbox entry', ctx.params.notificationId);
        }
        return entry;
      },
      respond: (ctx) => jsonResponse(200, serializeInboxEntry(ctx.result)),
    }),
  );

  // POST /api/agencies/:agencyId/notification-inbox/:notificationId/read —
  // the single sanctioned unread → read transition (terminal).
  router.add(
    'POST',
    '/api/agencies/:agencyId/notification-inbox/:notificationId/read',
    defineMutationRoute<{ agencyId: string; notificationId: string }, NotificationInboxEntry>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireNotificationDeliveryAgency(ctx.principal, ctx.params.agencyId);
      },
      validate: (ctx) =>
        validateObject<{ expectedVersion: number }>(ctx.request.body, {
          forbiddenKeys: NOTIFICATION_DELIVERY_AUTHORITY_FIELDS,
          fields: {
            expectedVersion: intField({ min: 1 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { expectedVersion: number };
        return modules.notificationDelivery.markInboxRead(
          {
            notificationId: ctx.params.notificationId,
            expectedVersion: body.expectedVersion,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('notificationdelivery.inbox.read', undefined, {
          notification_id: ctx.params.notificationId,
          agency_id: ctx.params.agencyId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'notificationdelivery.inbox.read',
          targetType: 'notification_inbox_state',
          targetId: ctx.params.notificationId,
          afterVersion: ctx.result.version,
          idempotencyKey: `notificationdelivery.inbox.read:${ctx.params.notificationId}`,
          details: { readStatus: ctx.result.readStatus },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInboxEntry(ctx.result)),
    }),
  );
}
