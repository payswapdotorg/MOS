/**
 * /creator-operations API routes (MKT-037 — the Creator Operations Domain
 * Pack: CREATOR-001).
 *
 *   POST /api/clients/:clientId/creator-profiles                       record a Creator Profile (owner|admin)
 *   GET  /api/clients/:clientId/creator-profiles                       the Client's profiles (any active member)
 *   GET  /api/creator-profiles/:profileId                              read one (boundary-checked; uniform 404 for foreign)
 *   POST /api/creator-profiles/:profileId/accounts                     record a Creator Account (owner|admin)
 *   GET  /api/creator-profiles/:profileId/accounts                     the profile's accounts
 *   POST /api/creator-accounts/:accountId/status                       CAS lifecycle edge (owner|admin)
 *   GET  /api/creator-accounts/:accountId                              read one
 *   POST /api/creator-accounts/:accountId/fans                         record a Fan (owner|admin)
 *   GET  /api/creator-accounts/:accountId/fans                         the account's fans
 *   POST /api/creator-fans/:fanId/status                               CAS lifecycle edge (owner|admin)
 *   GET  /api/creator-fans/:fanId                                      read one
 *   POST /api/creator-accounts/:accountId/conversations                open a Conversation (owner|admin)
 *   GET  /api/creator-accounts/:accountId/conversations                the account's conversations
 *   POST /api/creator-conversations/:conversationId/status             CAS lifecycle edge (owner|admin)
 *   GET  /api/creator-conversations/:conversationId                    read one
 *   POST /api/creator-conversations/:conversationId/messages/inbound   record an INBOUND observation (owner|admin)
 *   POST /api/creator-conversations/:conversationId/messages/outbound  THE approval-gated OUTBOUND send (owner|admin)
 *   GET  /api/creator-conversations/:conversationId/messages           the immutable history (any active member)
 *   POST /api/creator-conversations/:conversationId/approvals          record a human approval (the authenticated user)
 *   POST /api/creator-profiles/:profileId/content-assets               record a Content Asset (owner|admin)
 *   GET  /api/creator-profiles/:profileId/content-assets               the profile's assets
 *   POST /api/creator-content-assets/:assetId/status                   lifecycle edge — the PUBLISHED edge is the approval-gated side effect
 *   GET  /api/creator-content-assets/:assetId                          read one
 *   POST /api/creator-content-assets/:assetId/approvals               record a publish approval (the authenticated user)
 *   POST /api/creator-profiles/:profileId/offers                       record an Offer (owner|admin)
 *   GET  /api/creator-profiles/:profileId/offers                       the profile's offers
 *   POST /api/creator-offers/:offerId/status                           CAS lifecycle edge (owner|admin)
 *   GET  /api/creator-offers/:offerId                                  read one
 *   POST /api/clients/:clientId/creator-observations                   map one observation into the common evidence/metric ledgers (owner|admin)
 *   POST /api/creator-operations/publish                               publish the frozen pack manifest (platform admin or agency owner|admin)
 *   POST /api/workspaces/:workspaceId/creator-operations/task-profiles provision the pack's TaskProfiles (owner|admin)
 *
 * Server-derived authority posture (implementation-contract §3/§23): every
 * mutation resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the pack-owned row → its Client → the
 * /clients canonical chain), authorizes against the SAME /agencies
 * membership authority as every other scoped check and yields a UNIFORM
 * 404 for unknown/foreign identifiers (no cross-tenant oracle). Identity,
 * scope, lifecycle, provenance and gate provenance fields are NEVER
 * request-suppliable — the DTOs reject them explicitly, the approver of
 * every human approval is the authenticated principal, and the
 * policy-decision provenance is composed server-side (the /evidence
 * provenance posture).
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
  intField,
  numberField,
  objectField,
  recordField,
  stringField,
  validateObject,
  type FieldSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import {
  requireClientAccess,
  requirePlatformAdministrator,
  requireWorkspaceAccess,
  resolveContext,
} from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  CreatorAccountRecord,
  CreatorContentAssetRecord,
  CreatorConversationRecord,
  CreatorFanRecord,
  CreatorMessageRecord,
  CreatorOfferRecord,
  CreatorOperationApprovalRecord,
  CreatorProfileRecord,
  CreatorProvenance,
} from '../modules/domain-packs/public.ts';

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PLATFORM_LABEL_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ACCOUNT_HANDLE_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9_.@-]{0,127}$/;
const EVENT_KIND_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const STATUS_PATTERNS: Readonly<Record<string, RegExp>> = {
  account: /^(active|paused|retired)$/,
  fan: /^(subscribed|churned|removed)$/,
  conversation: /^(open|paused|closed)$/,
  content: /^(draft|in_review|approved|published|rejected)$/,
  offer: /^(draft|active|paused|retired)$/,
};

/**
 * Fields always server-derived on the pack surfaces — identity, scope,
 * lifecycle, gate provenance and evidence receipts are never
 * request-suppliable, and every material-shaped key is rejected outright
 * (§21/CRED-001).
 */
const CREATOR_AUTHORITY_FIELDS = [
  'profileId',
  'accountId',
  'conversationId',
  'messageId',
  'assetId',
  'offerId',
  'approvalId',
  'agencyId',
  'clientId',
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'retiredAt',
  'removedAt',
  'closedAt',
  'publishedAt',
  'rejectedAt',
  'policyDecisionId',
  'evidenceRef',
  'replayed',
  'provenance',
  'actor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'approverUserId',
  'approverSpecializations',
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

/** Fields server-derived on the approval surface (approver identity is the principal). */
const APPROVAL_AUTHORITY_FIELDS = [
  ...CREATOR_AUTHORITY_FIELDS.filter((field) => field !== 'approvalId'),
] as unknown as readonly string[];

/** Local boolean field spec (the field-agents-routes precedent). */
const booleanField: FieldSpec<boolean> = {
  required: true,
  parse: (value, problems) => {
    if (typeof value !== 'boolean') {
      problems.push('must be a boolean');
      return false;
    }
    return value;
  },
};

/** Local nullable object field spec: null/absent → null, otherwise the inner spec. */
function nullableObjectField(options: {
  fields: Record<string, unknown>;
}): FieldSpec<Record<string, unknown> | null> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined || value === null) return null;
      return objectField(options as Parameters<typeof objectField>[0]).parse(value, problems);
    },
  };
}

/** Local nullable string field spec (the field-agents-routes precedent). */
function nullableStringField(options: { pattern?: RegExp; minLength?: number; maxLength?: number }): FieldSpec<string | null> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined || value === null) return null;
      return stringField(options).parse(value, problems);
    },
  };
}

/**
 * SERVER-DERIVED provenance for the pack's gated operations and mapped
 * observations: actor from the authenticated principal, correlation from
 * the ambient context, recording system 'api'. No value here is reachable
 * from a request body (the DTOs reject every provenance-shaped key).
 */
function serverProvenance(principal: Principal): CreatorProvenance {
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

function serializeProfile(record: CreatorProfileRecord): Record<string, unknown> {
  return {
    profileId: record.profileId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    displayName: record.displayName,
    handle: record.handle,
    niches: record.niches,
    bio: record.bio,
    attributes: record.attributes,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
  };
}

function serializeAccount(record: CreatorAccountRecord): Record<string, unknown> {
  return {
    accountId: record.accountId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    profileId: record.profileId,
    platformLabel: record.platformLabel,
    accountHandle: record.accountHandle,
    status: record.status,
    metadata: record.metadata,
    version: record.version,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    ...(record.retiredAt === null ? {} : { retiredAt: record.retiredAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeFan(record: CreatorFanRecord): Record<string, unknown> {
  return {
    fanId: record.fanId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    accountId: record.accountId,
    fanAlias: record.fanAlias,
    status: record.status,
    tier: record.tier,
    tags: record.tags,
    attributes: record.attributes,
    version: record.version,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    ...(record.removedAt === null ? {} : { removedAt: record.removedAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeConversation(record: CreatorConversationRecord): Record<string, unknown> {
  return {
    conversationId: record.conversationId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    accountId: record.accountId,
    fanId: record.fanId,
    status: record.status,
    channel: record.channel,
    topic: record.topic,
    attributes: record.attributes,
    version: record.version,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    ...(record.closedAt === null ? {} : { closedAt: record.closedAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeMessage(record: CreatorMessageRecord): Record<string, unknown> {
  return {
    messageId: record.messageId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    conversationId: record.conversationId,
    direction: record.direction,
    status: record.status,
    body: record.body,
    // The gate provenance of the outbound side effect (server-derived).
    ...(record.policyDecisionId === null ? {} : { policyDecisionId: record.policyDecisionId }),
    ...(record.approvalId === null ? {} : { approvalId: record.approvalId }),
    ...(record.evidenceRef === null ? {} : { evidenceRef: record.evidenceRef }),
    idempotencyKey: record.idempotencyKey,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
  };
}

function serializeContentAsset(record: CreatorContentAssetRecord): Record<string, unknown> {
  return {
    assetId: record.assetId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    profileId: record.profileId,
    status: record.status,
    title: record.title,
    contentKind: record.contentKind,
    plannedPlatforms: record.plannedPlatforms,
    brief: record.brief,
    attributes: record.attributes,
    version: record.version,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    ...(record.publishedAt === null ? {} : { publishedAt: record.publishedAt }),
    ...(record.rejectedAt === null ? {} : { rejectedAt: record.rejectedAt }),
    ...(record.policyDecisionId === null ? {} : { policyDecisionId: record.policyDecisionId }),
    ...(record.approvalId === null ? {} : { approvalId: record.approvalId }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeOffer(record: CreatorOfferRecord): Record<string, unknown> {
  return {
    offerId: record.offerId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    profileId: record.profileId,
    status: record.status,
    title: record.title,
    offerKind: record.offerKind,
    priceCents: record.priceCents,
    currency: record.currency,
    terms: record.terms,
    attributes: record.attributes,
    version: record.version,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    ...(record.retiredAt === null ? {} : { retiredAt: record.retiredAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeApproval(record: CreatorOperationApprovalRecord): Record<string, unknown> {
  return {
    approvalId: record.approvalId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    action: record.action,
    resourceId: record.resourceId,
    decision: record.decision,
    approverUserId: record.approverUserId,
    approverSpecializations: record.approverSpecializations,
    notes: record.notes,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerCreatorOperationsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('creator-operations.api');
  const pack = modules.creatorOperations;

  /** Canonical Client owner scope; 404 BEFORE dependent traversal. */
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

  /** Resolves a pack-owned parent row's Client owner scope (uniform 404). */
  async function parentRowOwner(
    row: { clientId: string } | null,
    subject: string,
    id: string,
  ): Promise<OwnerScope> {
    if (row === null) {
      throw new NotFoundError(subject, id);
    }
    return clientOwner(row.clientId);
  }

  /**
   * Publisher authorization for the frozen manifest publication: platform
   * administrators or an active agency owner/admin membership (the same
   * posture as the generic framework publish route).
   */
  async function requirePublisherRole(principal: Principal): Promise<void> {
    if (principal.kind === 'service') return;
    const context = await requirePlatformAdministrator(modules, principal).catch(() => null);
    if (context !== null) return;
    const userContext = await resolveContext(modules, principal);
    if (userContext === null || userContext.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    const publisherMembership = userContext.memberships.find(
      (entry) => entry.membershipStatus === 'active' && (entry.role === 'agency_owner' || entry.role === 'agency_admin'),
    );
    if (publisherMembership === undefined) {
      throw new ForbiddenError('Publishing the Creator Operations pack requires the platform administrator role or an active agency owner/admin membership');
    }
  }

  /** The approver's Human Agent specializations, resolved server-side from the /field-agents profile. */
  async function approverSpecializations(userId: string): Promise<readonly string[]> {
    const profile = await modules.fieldAgents.getHumanAgentByUser(userId);
    return profile === null ? [] : [...profile.specializations];
  }

  // -------------------------------------------------------------------------
  // Creator Profiles
  // -------------------------------------------------------------------------

  // POST /api/clients/:clientId/creator-profiles — record one Creator
  // Profile (append-only, Client-scoped).
  router.add(
    'POST',
    '/api/clients/:clientId/creator-profiles',
    defineMutationRoute<{ clientId: string }, CreatorProfileRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          displayName: string;
          handle: string;
          niches: string[];
          bio: string;
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            displayName: stringField({ minLength: 1, maxLength: 200 }),
            handle: stringField({ pattern: HANDLE_PATTERN }),
            niches: arrayField({ minItems: 0, maxItems: 32, item: stringField({ minLength: 1, maxLength: 64 }) }),
            bio: stringField({ minLength: 0, maxLength: 2000 }),
            attributes: recordField({ maxDepthKeys: 64 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          displayName: string;
          handle: string;
          niches: string[];
          bio: string;
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        };
        return pack.recordCreatorProfile(
          {
            clientId: ctx.params.clientId,
            displayName: body.displayName,
            handle: body.handle,
            niches: body.niches,
            bio: body.bio,
            attributes: body.attributes,
            idempotencyKey: body.idempotencyKey,
          },
          ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.profile.recorded', undefined, {
          profile_id: ctx.result.profileId,
          client_id: ctx.params.clientId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.profile.recorded',
          targetType: 'creator_profile',
          targetId: ctx.result.profileId,
          idempotencyKey: `creator_operations.profile.recorded:${ctx.result.profileId}`,
          details: { handle: ctx.result.handle, clientId: ctx.result.clientId },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeProfile(ctx.result)),
    }),
  );

  // GET /api/clients/:clientId/creator-profiles — the Client's profiles.
  router.add(
    'GET',
    '/api/clients/:clientId/creator-profiles',
    defineQueryRoute<{ clientId: string }, readonly CreatorProfileRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => pack.listCreatorProfilesForClient(ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          profiles: ctx.result.map(serializeProfile),
        }),
    }),
  );

  // GET /api/creator-profiles/:profileId — read one (boundary-checked).
  router.add(
    'GET',
    '/api/creator-profiles/:profileId',
    defineQueryRoute<{ profileId: string }, CreatorProfileRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const profile = await pack.getCreatorProfile(ctx.params.profileId);
        if (profile === null) {
          throw new NotFoundError('creator profile', ctx.params.profileId);
        }
        await requireClientAccess(modules, ctx.principal, profile.clientId);
      },
      execute: async (ctx) => {
        const profile = await pack.getCreatorProfile(ctx.params.profileId);
        if (profile === null) {
          throw new NotFoundError('creator profile', ctx.params.profileId);
        }
        return profile;
      },
      respond: (ctx) => jsonResponse(200, serializeProfile(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // Creator Accounts
  // -------------------------------------------------------------------------

  // POST /api/creator-profiles/:profileId/accounts — record one account.
  router.add(
    'POST',
    '/api/creator-profiles/:profileId/accounts',
    defineMutationRoute<{ profileId: string }, CreatorAccountRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorProfile(params.profileId), 'creator profile', params.profileId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          platformLabel: string;
          accountHandle: string;
          metadata: Record<string, unknown>;
          idempotencyKey: string;
        }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            platformLabel: stringField({ pattern: PLATFORM_LABEL_PATTERN }),
            accountHandle: stringField({ pattern: ACCOUNT_HANDLE_PATTERN }),
            metadata: recordField({ maxDepthKeys: 64 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          platformLabel: string;
          accountHandle: string;
          metadata: Record<string, unknown>;
          idempotencyKey: string;
        };
        return pack.recordCreatorAccount(
          {
            profileId: ctx.params.profileId,
            platformLabel: body.platformLabel,
            accountHandle: body.accountHandle,
            metadata: body.metadata,
            idempotencyKey: body.idempotencyKey,
          },
          ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.account.recorded', undefined, {
          account_id: ctx.result.accountId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.account.recorded',
          targetType: 'creator_account',
          targetId: ctx.result.accountId,
          idempotencyKey: `creator_operations.account.recorded:${ctx.result.accountId}`,
          details: { platformLabel: ctx.result.platformLabel, status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeAccount(ctx.result)),
    }),
  );

  // GET /api/creator-profiles/:profileId/accounts — the profile's accounts.
  router.add(
    'GET',
    '/api/creator-profiles/:profileId/accounts',
    defineQueryRoute<{ profileId: string }, readonly CreatorAccountRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const profile = await pack.getCreatorProfile(ctx.params.profileId);
        if (profile === null) {
          throw new NotFoundError('creator profile', ctx.params.profileId);
        }
        await requireClientAccess(modules, ctx.principal, profile.clientId);
      },
      execute: async (ctx) => pack.listCreatorAccountsForProfile(ctx.params.profileId),
      respond: (ctx) =>
        jsonResponse(200, { profileId: ctx.params.profileId, accounts: ctx.result.map(serializeAccount) }),
    }),
  );

  // GET /api/creator-accounts/:accountId — read one.
  router.add(
    'GET',
    '/api/creator-accounts/:accountId',
    defineQueryRoute<{ accountId: string }, CreatorAccountRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const account = await pack.getCreatorAccount(ctx.params.accountId);
        if (account === null) {
          throw new NotFoundError('creator account', ctx.params.accountId);
        }
        await requireClientAccess(modules, ctx.principal, account.clientId);
      },
      execute: async (ctx) => {
        const account = await pack.getCreatorAccount(ctx.params.accountId);
        if (account === null) {
          throw new NotFoundError('creator account', ctx.params.accountId);
        }
        return account;
      },
      respond: (ctx) => jsonResponse(200, serializeAccount(ctx.result)),
    }),
  );

  // POST /api/creator-accounts/:accountId/status — the CAS lifecycle edge.
  router.add(
    'POST',
    '/api/creator-accounts/:accountId/status',
    defineMutationRoute<{ accountId: string }, CreatorAccountRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorAccount(params.accountId), 'creator account', params.accountId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ to: string; expectedVersion: number }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            to: stringField({ pattern: STATUS_PATTERNS['account']! }),
            expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { to: CreatorAccountRecord['status']; expectedVersion: number };
        return pack.setCreatorAccountStatus({
          accountId: ctx.params.accountId,
          status: body.to,
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('creator_operations.account.status', undefined, {
          account_id: ctx.result.accountId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.account.status',
          targetType: 'creator_account',
          targetId: ctx.result.accountId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeAccount(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // Fans
  // -------------------------------------------------------------------------

  // POST /api/creator-accounts/:accountId/fans — record one fan.
  router.add(
    'POST',
    '/api/creator-accounts/:accountId/fans',
    defineMutationRoute<{ accountId: string }, CreatorFanRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorAccount(params.accountId), 'creator account', params.accountId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          fanAlias: string;
          tier: string;
          tags: string[];
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            fanAlias: stringField({ minLength: 1, maxLength: 128 }),
            tier: stringField({ pattern: /^(standard|vip|top_fan|new_fan)$/ }),
            tags: arrayField({ minItems: 0, maxItems: 32, item: stringField({ minLength: 1, maxLength: 64 }) }),
            attributes: recordField({ maxDepthKeys: 64 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          fanAlias: string;
          tier: CreatorFanRecord['tier'];
          tags: string[];
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        };
        return pack.recordCreatorFan(
          {
            accountId: ctx.params.accountId,
            fanAlias: body.fanAlias,
            tier: body.tier,
            tags: body.tags,
            attributes: body.attributes,
            idempotencyKey: body.idempotencyKey,
          },
          ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.fan.recorded', undefined, {
          fan_id: ctx.result.fanId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.fan.recorded',
          targetType: 'creator_fan',
          targetId: ctx.result.fanId,
          idempotencyKey: `creator_operations.fan.recorded:${ctx.result.fanId}`,
          details: { tier: ctx.result.tier, status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeFan(ctx.result)),
    }),
  );

  // GET /api/creator-accounts/:accountId/fans — the account's fans.
  router.add(
    'GET',
    '/api/creator-accounts/:accountId/fans',
    defineQueryRoute<{ accountId: string }, readonly CreatorFanRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const account = await pack.getCreatorAccount(ctx.params.accountId);
        if (account === null) {
          throw new NotFoundError('creator account', ctx.params.accountId);
        }
        await requireClientAccess(modules, ctx.principal, account.clientId);
      },
      execute: async (ctx) => pack.listCreatorFansForAccount(ctx.params.accountId),
      respond: (ctx) =>
        jsonResponse(200, { accountId: ctx.params.accountId, fans: ctx.result.map(serializeFan) }),
    }),
  );

  // GET /api/creator-fans/:fanId — read one.
  router.add(
    'GET',
    '/api/creator-fans/:fanId',
    defineQueryRoute<{ fanId: string }, CreatorFanRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const fan = await pack.getCreatorFan(ctx.params.fanId);
        if (fan === null) {
          throw new NotFoundError('creator fan', ctx.params.fanId);
        }
        await requireClientAccess(modules, ctx.principal, fan.clientId);
      },
      execute: async (ctx) => {
        const fan = await pack.getCreatorFan(ctx.params.fanId);
        if (fan === null) {
          throw new NotFoundError('creator fan', ctx.params.fanId);
        }
        return fan;
      },
      respond: (ctx) => jsonResponse(200, serializeFan(ctx.result)),
    }),
  );

  // POST /api/creator-fans/:fanId/status — the CAS lifecycle edge.
  router.add(
    'POST',
    '/api/creator-fans/:fanId/status',
    defineMutationRoute<{ fanId: string }, CreatorFanRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorFan(params.fanId), 'creator fan', params.fanId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ to: string; expectedVersion: number }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            to: stringField({ pattern: STATUS_PATTERNS['fan']! }),
            expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { to: CreatorFanRecord['status']; expectedVersion: number };
        return pack.setCreatorFanStatus({
          fanId: ctx.params.fanId,
          status: body.to,
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('creator_operations.fan.status', undefined, {
          fan_id: ctx.result.fanId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.fan.status',
          targetType: 'creator_fan',
          targetId: ctx.result.fanId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeFan(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  // POST /api/creator-accounts/:accountId/conversations — open one.
  router.add(
    'POST',
    '/api/creator-accounts/:accountId/conversations',
    defineMutationRoute<{ accountId: string }, CreatorConversationRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorAccount(params.accountId), 'creator account', params.accountId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          fanId: string;
          channel: string;
          topic: string;
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            fanId: stringField({ pattern: UUID_PATTERN }),
            channel: stringField({ pattern: /^(dm|post_comment|live_chat|email)$/ }),
            topic: stringField({ minLength: 0, maxLength: 200 }),
            attributes: recordField({ maxDepthKeys: 64 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          fanId: string;
          channel: CreatorConversationRecord['channel'];
          topic: string;
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        };
        return pack.openCreatorConversation(
          {
            accountId: ctx.params.accountId,
            fanId: body.fanId,
            channel: body.channel,
            topic: body.topic,
            attributes: body.attributes,
            idempotencyKey: body.idempotencyKey,
          },
          ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.conversation.opened', undefined, {
          conversation_id: ctx.result.conversationId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.conversation.opened',
          targetType: 'creator_conversation',
          targetId: ctx.result.conversationId,
          idempotencyKey: `creator_operations.conversation.opened:${ctx.result.conversationId}`,
          details: { channel: ctx.result.channel, status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeConversation(ctx.result)),
    }),
  );

  // GET /api/creator-accounts/:accountId/conversations — the account's conversations.
  router.add(
    'GET',
    '/api/creator-accounts/:accountId/conversations',
    defineQueryRoute<{ accountId: string }, readonly CreatorConversationRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const account = await pack.getCreatorAccount(ctx.params.accountId);
        if (account === null) {
          throw new NotFoundError('creator account', ctx.params.accountId);
        }
        await requireClientAccess(modules, ctx.principal, account.clientId);
      },
      execute: async (ctx) => pack.listCreatorConversationsForAccount(ctx.params.accountId),
      respond: (ctx) =>
        jsonResponse(200, {
          accountId: ctx.params.accountId,
          conversations: ctx.result.map(serializeConversation),
        }),
    }),
  );

  // GET /api/creator-conversations/:conversationId — read one.
  router.add(
    'GET',
    '/api/creator-conversations/:conversationId',
    defineQueryRoute<{ conversationId: string }, CreatorConversationRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const conversation = await pack.getCreatorConversation(ctx.params.conversationId);
        if (conversation === null) {
          throw new NotFoundError('creator conversation', ctx.params.conversationId);
        }
        await requireClientAccess(modules, ctx.principal, conversation.clientId);
      },
      execute: async (ctx) => {
        const conversation = await pack.getCreatorConversation(ctx.params.conversationId);
        if (conversation === null) {
          throw new NotFoundError('creator conversation', ctx.params.conversationId);
        }
        return conversation;
      },
      respond: (ctx) => jsonResponse(200, serializeConversation(ctx.result)),
    }),
  );

  // POST /api/creator-conversations/:conversationId/status — the CAS lifecycle edge.
  router.add(
    'POST',
    '/api/creator-conversations/:conversationId/status',
    defineMutationRoute<{ conversationId: string }, CreatorConversationRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(
          await pack.getCreatorConversation(params.conversationId),
          'creator conversation',
          params.conversationId,
        ),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ to: string; expectedVersion: number }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            to: stringField({ pattern: STATUS_PATTERNS['conversation']! }),
            expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          to: CreatorConversationRecord['status'];
          expectedVersion: number;
        };
        return pack.setCreatorConversationStatus({
          conversationId: ctx.params.conversationId,
          status: body.to,
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('creator_operations.conversation.status', undefined, {
          conversation_id: ctx.result.conversationId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.conversation.status',
          targetType: 'creator_conversation',
          targetId: ctx.result.conversationId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeConversation(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // Messages — the inbound observation and THE approval-gated outbound send
  // -------------------------------------------------------------------------

  // POST /api/creator-conversations/:conversationId/messages/inbound —
  // an OBSERVATION (born 'received'; optional evidence mapping).
  router.add(
    'POST',
    '/api/creator-conversations/:conversationId/messages/inbound',
    defineMutationRoute<{ conversationId: string }, CreatorMessageRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(
          await pack.getCreatorConversation(params.conversationId),
          'creator conversation',
          params.conversationId,
        ),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          body: string;
          idempotencyKey: string;
          mapToEvidence: boolean;
        }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            body: stringField({ minLength: 1, maxLength: 4000 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
            mapToEvidence: booleanField,
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { body: string; idempotencyKey: string; mapToEvidence: boolean };
        return pack.recordCreatorInboundMessage(
          {
            conversationId: ctx.params.conversationId,
            body: body.body,
            idempotencyKey: body.idempotencyKey,
            approvalId: null,
            mapToEvidence: body.mapToEvidence,
          },
          ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.message.received', undefined, {
          message_id: ctx.result.messageId,
          conversation_id: ctx.params.conversationId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.message.received',
          targetType: 'creator_message',
          targetId: ctx.result.messageId,
          idempotencyKey: `creator_operations.message.received:${ctx.result.messageId}`,
          details: { direction: ctx.result.direction },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeMessage(ctx.result)),
    }),
  );

  // POST /api/creator-conversations/:conversationId/messages/outbound —
  // THE CREATOR-AC-06 approval-gated side effect (born 'sent' only through
  // the fail-closed policy + approval gate).
  router.add(
    'POST',
    '/api/creator-conversations/:conversationId/messages/outbound',
    defineMutationRoute<{ conversationId: string }, CreatorMessageRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(
          await pack.getCreatorConversation(params.conversationId),
          'creator conversation',
          params.conversationId,
        ),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          body: string;
          idempotencyKey: string;
          approvalId: string | null;
        }>(ctx.request.body, {
          // The approval id IS presentable here (a caller-supplied
          // REFERENCE the gate re-verifies server-side); every authority,
          // provenance and material key stays rejected.
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS.filter(
            (field) => field !== 'approvalId',
          ) as unknown as readonly string[],
          fields: {
            body: stringField({ minLength: 1, maxLength: 4000 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
            approvalId: nullableStringField({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { body: string; idempotencyKey: string; approvalId: string | null };
        return pack.sendCreatorOutboundMessage(
          {
            conversationId: ctx.params.conversationId,
            body: body.body,
            idempotencyKey: body.idempotencyKey,
            approvalId: body.approvalId,
          },
          ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.message.sent', undefined, {
          message_id: ctx.result.messageId,
          conversation_id: ctx.params.conversationId,
          policy_decision_id: ctx.result.policyDecisionId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.message.sent',
          targetType: 'creator_message',
          targetId: ctx.result.messageId,
          idempotencyKey: `creator_operations.message.sent:${ctx.result.messageId}`,
          details: {
            direction: ctx.result.direction,
            approvalId: ctx.result.approvalId,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeMessage(ctx.result)),
    }),
  );

  // GET /api/creator-conversations/:conversationId/messages — the history.
  router.add(
    'GET',
    '/api/creator-conversations/:conversationId/messages',
    defineQueryRoute<{ conversationId: string }, readonly CreatorMessageRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const conversation = await pack.getCreatorConversation(ctx.params.conversationId);
        if (conversation === null) {
          throw new NotFoundError('creator conversation', ctx.params.conversationId);
        }
        await requireClientAccess(modules, ctx.principal, conversation.clientId);
      },
      execute: async (ctx) => pack.listCreatorMessages(ctx.params.conversationId),
      respond: (ctx) =>
        jsonResponse(200, {
          conversationId: ctx.params.conversationId,
          messages: ctx.result.map(serializeMessage),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // Content assets
  // -------------------------------------------------------------------------

  // POST /api/creator-profiles/:profileId/content-assets — record one.
  router.add(
    'POST',
    '/api/creator-profiles/:profileId/content-assets',
    defineMutationRoute<{ profileId: string }, CreatorContentAssetRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorProfile(params.profileId), 'creator profile', params.profileId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          title: string;
          contentKind: string;
          plannedPlatforms: string[];
          brief: string;
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            title: stringField({ minLength: 1, maxLength: 200 }),
            contentKind: stringField({
              pattern: /^(post|video_short|video_long|photo_set|stream|newsletter)$/,
            }),
            plannedPlatforms: arrayField({
              minItems: 0,
              maxItems: 32,
              item: stringField({ minLength: 1, maxLength: 64 }),
            }),
            brief: stringField({ minLength: 0, maxLength: 4000 }),
            attributes: recordField({ maxDepthKeys: 64 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          title: string;
          contentKind: CreatorContentAssetRecord['contentKind'];
          plannedPlatforms: string[];
          brief: string;
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        };
        return pack.recordCreatorContentAsset(
          {
            profileId: ctx.params.profileId,
            title: body.title,
            contentKind: body.contentKind,
            plannedPlatforms: body.plannedPlatforms,
            brief: body.brief,
            attributes: body.attributes,
            idempotencyKey: body.idempotencyKey,
          },
          ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.content.recorded', undefined, {
          asset_id: ctx.result.assetId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.content.recorded',
          targetType: 'creator_content_asset',
          targetId: ctx.result.assetId,
          idempotencyKey: `creator_operations.content.recorded:${ctx.result.assetId}`,
          details: { contentKind: ctx.result.contentKind, status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeContentAsset(ctx.result)),
    }),
  );

  // GET /api/creator-profiles/:profileId/content-assets — the profile's assets.
  router.add(
    'GET',
    '/api/creator-profiles/:profileId/content-assets',
    defineQueryRoute<{ profileId: string }, readonly CreatorContentAssetRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const profile = await pack.getCreatorProfile(ctx.params.profileId);
        if (profile === null) {
          throw new NotFoundError('creator profile', ctx.params.profileId);
        }
        await requireClientAccess(modules, ctx.principal, profile.clientId);
      },
      execute: async (ctx) => pack.listCreatorContentAssetsForProfile(ctx.params.profileId),
      respond: (ctx) =>
        jsonResponse(200, { profileId: ctx.params.profileId, assets: ctx.result.map(serializeContentAsset) }),
    }),
  );

  // GET /api/creator-content-assets/:assetId — read one.
  router.add(
    'GET',
    '/api/creator-content-assets/:assetId',
    defineQueryRoute<{ assetId: string }, CreatorContentAssetRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const asset = await pack.getCreatorContentAsset(ctx.params.assetId);
        if (asset === null) {
          throw new NotFoundError('creator content asset', ctx.params.assetId);
        }
        await requireClientAccess(modules, ctx.principal, asset.clientId);
      },
      execute: async (ctx) => {
        const asset = await pack.getCreatorContentAsset(ctx.params.assetId);
        if (asset === null) {
          throw new NotFoundError('creator content asset', ctx.params.assetId);
        }
        return asset;
      },
      respond: (ctx) => jsonResponse(200, serializeContentAsset(ctx.result)),
    }),
  );

  // POST /api/creator-content-assets/:assetId/status — the lifecycle edge
  // (the PUBLISHED edge is the approval-gated side effect).
  router.add(
    'POST',
    '/api/creator-content-assets/:assetId/status',
    defineMutationRoute<{ assetId: string }, CreatorContentAssetRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorContentAsset(params.assetId), 'creator content asset', params.assetId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          to: string;
          expectedVersion: number;
          approvalId: string | null;
        }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS.filter(
            (field) => field !== 'approvalId',
          ) as unknown as readonly string[],
          fields: {
            to: stringField({ pattern: STATUS_PATTERNS['content']! }),
            expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            approvalId: nullableStringField({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          to: CreatorContentAssetRecord['status'];
          expectedVersion: number;
          approvalId: string | null;
        };
        return pack.transitionCreatorContentAsset({
          assetId: ctx.params.assetId,
          status: body.to,
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          approvalId: body.approvalId,
          // The policy-decision provenance of the publish gate is
          // SERVER-DERIVED (composed here, never from the body).
          provenance: body.to === 'published' ? serverProvenance(ctx.principal) : null,
        });
      },
      emit: async (ctx) => {
        logger.info('creator_operations.content.status', undefined, {
          asset_id: ctx.result.assetId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.content.status',
          targetType: 'creator_content_asset',
          targetId: ctx.result.assetId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeContentAsset(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // Offers
  // -------------------------------------------------------------------------

  // POST /api/creator-profiles/:profileId/offers — record one.
  router.add(
    'POST',
    '/api/creator-profiles/:profileId/offers',
    defineMutationRoute<{ profileId: string }, CreatorOfferRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorProfile(params.profileId), 'creator profile', params.profileId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          title: string;
          offerKind: string;
          priceCents: number;
          currency: string;
          terms: string;
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            title: stringField({ minLength: 1, maxLength: 200 }),
            offerKind: stringField({ pattern: /^(subscription|ppv_message|bundle|custom|tip)$/ }),
            priceCents: intField({ min: 0, max: Number.MAX_SAFE_INTEGER }),
            currency: stringField({ pattern: /^[A-Z]{3}$/ }),
            terms: stringField({ minLength: 0, maxLength: 2000 }),
            attributes: recordField({ maxDepthKeys: 64 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          title: string;
          offerKind: CreatorOfferRecord['offerKind'];
          priceCents: number;
          currency: string;
          terms: string;
          attributes: Record<string, unknown>;
          idempotencyKey: string;
        };
        return pack.recordCreatorOffer(
          {
            profileId: ctx.params.profileId,
            title: body.title,
            offerKind: body.offerKind,
            priceCents: body.priceCents,
            currency: body.currency,
            terms: body.terms,
            attributes: body.attributes,
            idempotencyKey: body.idempotencyKey,
          },
          ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.offer.recorded', undefined, {
          offer_id: ctx.result.offerId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.offer.recorded',
          targetType: 'creator_offer',
          targetId: ctx.result.offerId,
          idempotencyKey: `creator_operations.offer.recorded:${ctx.result.offerId}`,
          details: { offerKind: ctx.result.offerKind, priceCents: ctx.result.priceCents },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeOffer(ctx.result)),
    }),
  );

  // GET /api/creator-profiles/:profileId/offers — the profile's offers.
  router.add(
    'GET',
    '/api/creator-profiles/:profileId/offers',
    defineQueryRoute<{ profileId: string }, readonly CreatorOfferRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const profile = await pack.getCreatorProfile(ctx.params.profileId);
        if (profile === null) {
          throw new NotFoundError('creator profile', ctx.params.profileId);
        }
        await requireClientAccess(modules, ctx.principal, profile.clientId);
      },
      execute: async (ctx) => pack.listCreatorOffersForProfile(ctx.params.profileId),
      respond: (ctx) =>
        jsonResponse(200, { profileId: ctx.params.profileId, offers: ctx.result.map(serializeOffer) }),
    }),
  );

  // GET /api/creator-offers/:offerId — read one.
  router.add(
    'GET',
    '/api/creator-offers/:offerId',
    defineQueryRoute<{ offerId: string }, CreatorOfferRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const offer = await pack.getCreatorOffer(ctx.params.offerId);
        if (offer === null) {
          throw new NotFoundError('creator offer', ctx.params.offerId);
        }
        await requireClientAccess(modules, ctx.principal, offer.clientId);
      },
      execute: async (ctx) => {
        const offer = await pack.getCreatorOffer(ctx.params.offerId);
        if (offer === null) {
          throw new NotFoundError('creator offer', ctx.params.offerId);
        }
        return offer;
      },
      respond: (ctx) => jsonResponse(200, serializeOffer(ctx.result)),
    }),
  );

  // POST /api/creator-offers/:offerId/status — the CAS lifecycle edge.
  router.add(
    'POST',
    '/api/creator-offers/:offerId/status',
    defineMutationRoute<{ offerId: string }, CreatorOfferRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorOffer(params.offerId), 'creator offer', params.offerId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ to: string; expectedVersion: number }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            to: stringField({ pattern: STATUS_PATTERNS['offer']! }),
            expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { to: CreatorOfferRecord['status']; expectedVersion: number };
        return pack.setCreatorOfferStatus({
          offerId: ctx.params.offerId,
          status: body.to,
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('creator_operations.offer.status', undefined, {
          offer_id: ctx.result.offerId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.offer.status',
          targetType: 'creator_offer',
          targetId: ctx.result.offerId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeOffer(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // The pack-owned human approvals (CREATOR-AC-06)
  // -------------------------------------------------------------------------

  /** Shared approval recorder: the approver is the authenticated principal. */
  function registerApprovalRoute(
    path: string,
    action: 'creator.conversation.send' | 'creator.content.publish',
    resolveTarget: (params: Record<string, string>) => string,
    resolveTargetRow: (resourceId: string) => Promise<{ clientId: string } | null>,
    subject: string,
  ): void {
    router.add(
      'POST',
      path,
      defineMutationRoute<Record<string, string>, CreatorOperationApprovalRecord>({
        authenticator: services.auth,
        resolveOwner: async (_ctx, params) =>
          parentRowOwner(await resolveTargetRow(resolveTarget(params)), subject, resolveTarget(params)),
        authorize: async (ctx) => {
          // A HUMAN approval requires a HUMAN principal (service tokens
          // never approve).
          if (ctx.principal.kind !== 'user') {
            throw new ForbiddenError('Creator operation approvals require an authenticated human user');
          }
          await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
            'agency_owner',
            'agency_admin',
          ]);
        },
        validate: (ctx) =>
          validateObject<{
            decision: string;
            notes: string;
            idempotencyKey: string;
          }>(ctx.request.body, {
            forbiddenKeys: APPROVAL_AUTHORITY_FIELDS,
            fields: {
              decision: stringField({ pattern: /^(approved|rejected)$/ }),
              notes: stringField({ minLength: 0, maxLength: 2000 }),
              idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
            },
          }),
        execute: async (ctx) => {
          const body = ctx.validated as { decision: 'approved' | 'rejected'; notes: string; idempotencyKey: string };
          if (ctx.principal.kind !== 'user') {
            throw new ForbiddenError('Creator operation approvals require an authenticated human user');
          }
          const clientId = (ctx.owner as { clientId: string }).clientId;
          const resourceId = resolveTarget(ctx.params);
          return pack.recordCreatorOperationApproval(
            {
              clientId,
              action: action as 'creator.conversation.send' | 'creator.content.publish',
              resourceId,
              decision: body.decision,
              // SERVER-DERIVED approver provenance: the authenticated
              // principal and their /field-agents Human Agent
              // specializations (never request-suppliable).
              approverUserId: ctx.principal.userId,
              approverSpecializations: await approverSpecializations(ctx.principal.userId),
              notes: body.notes,
              idempotencyKey: body.idempotencyKey,
            },
            ctx.principal.userId,
            serverProvenance(ctx.principal),
          );
        },
        emit: async (ctx) => {
          logger.info('creator_operations.approval.recorded', undefined, {
            approval_id: ctx.result.approvalId,
            action: ctx.result.action,
            decision: ctx.result.decision,
            correlation_id: currentCorrelation().correlationId,
          });
          await recordMutationAudit(modules, ctx.principal, ctx.owner, {
            action: 'creator_operations.approval.recorded',
            targetType: 'creator_operation_approval',
            targetId: ctx.result.approvalId,
            idempotencyKey: `creator_operations.approval.recorded:${ctx.result.approvalId}`,
            details: {
              gateAction: ctx.result.action,
              decision: ctx.result.decision,
              approverUserId: ctx.result.approverUserId,
              approverSpecializations: ctx.result.approverSpecializations.join(','),
            },
          });
        },
        respond: (ctx) => jsonResponse(201, serializeApproval(ctx.result)),
      }),
    );
  }

  // POST /api/creator-conversations/:conversationId/approvals — the send
  // gate approval, recorded by the authenticated human.
  registerApprovalRoute(
    '/api/creator-conversations/:conversationId/approvals',
    'creator.conversation.send',
    (params) => params['conversationId']!,
    (resourceId) => pack.getCreatorConversation(resourceId),
    'creator conversation',
  );

  // POST /api/creator-content-assets/:assetId/approvals — the publish gate
  // approval, recorded by the authenticated human.
  router.add(
    'POST',
    '/api/creator-content-assets/:assetId/approvals',
    defineMutationRoute<{ assetId: string }, CreatorOperationApprovalRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) =>
        parentRowOwner(await pack.getCreatorContentAsset(params.assetId), 'creator content asset', params.assetId),
      authorize: async (ctx) => {
        if (ctx.principal.kind !== 'user') {
          throw new ForbiddenError('Creator operation approvals require an authenticated human user');
        }
        await requireClientAccess(modules, ctx.principal, (ctx.owner as { clientId: string }).clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ decision: string; notes: string; idempotencyKey: string }>(ctx.request.body, {
          forbiddenKeys: APPROVAL_AUTHORITY_FIELDS,
          fields: {
            decision: stringField({ pattern: /^(approved|rejected)$/ }),
            notes: stringField({ minLength: 0, maxLength: 2000 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { decision: 'approved' | 'rejected'; notes: string; idempotencyKey: string };
        if (ctx.principal.kind !== 'user') {
          throw new ForbiddenError('Creator operation approvals require an authenticated human user');
        }
        return pack.recordCreatorOperationApproval(
          {
            clientId: (ctx.owner as { clientId: string }).clientId,
            action: 'creator.content.publish',
            resourceId: ctx.params.assetId,
            decision: body.decision,
            approverUserId: ctx.principal.userId,
            approverSpecializations: await approverSpecializations(ctx.principal.userId),
            notes: body.notes,
            idempotencyKey: body.idempotencyKey,
          },
          ctx.principal.userId,
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.approval.recorded', undefined, {
          approval_id: ctx.result.approvalId,
          action: ctx.result.action,
          decision: ctx.result.decision,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.approval.recorded',
          targetType: 'creator_operation_approval',
          targetId: ctx.result.approvalId,
          idempotencyKey: `creator_operations.approval.recorded:${ctx.result.approvalId}`,
          details: {
            gateAction: ctx.result.action,
            decision: ctx.result.decision,
            approverUserId: ctx.result.approverUserId,
            approverSpecializations: ctx.result.approverSpecializations.join(','),
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeApproval(ctx.result)),
    }),
  );

  // GET /api/creator-conversations/:conversationId/approvals — the send
  // gate approval history of this conversation.
  router.add(
    'GET',
    '/api/creator-conversations/:conversationId/approvals',
    defineQueryRoute<{ conversationId: string }, readonly CreatorOperationApprovalRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const conversation = await pack.getCreatorConversation(ctx.params.conversationId);
        if (conversation === null) {
          throw new NotFoundError('creator conversation', ctx.params.conversationId);
        }
        await requireClientAccess(modules, ctx.principal, conversation.clientId);
      },
      execute: async (ctx) =>
        pack.listCreatorApprovalsForResource({
          action: 'creator.conversation.send',
          resourceId: ctx.params.conversationId,
        }),
      respond: (ctx) =>
        jsonResponse(200, {
          action: 'creator.conversation.send',
          resourceId: ctx.params.conversationId,
          approvals: ctx.result.map(serializeApproval),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // The observation mapping (CREATOR-AC-02)
  // -------------------------------------------------------------------------

  // POST /api/clients/:clientId/creator-observations — map one observation
  // into the COMMON /evidence and /metrics ledgers.
  router.add(
    'POST',
    '/api/clients/:clientId/creator-observations',
    defineMutationRoute<{ clientId: string }, { evidenceId: string; observationId: string | null }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          workspaceId: string | null;
          subjectKind: string;
          subjectRef: string | null;
          eventKind: string;
          content: Record<string, unknown>;
          observedAt: string;
          quality: string;
          metric: Record<string, unknown> | null;
          idempotencyKey: string;
        }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            workspaceId: nullableStringField({ pattern: UUID_PATTERN }),
            subjectKind: stringField({
              pattern: /^(audience|conversation|content|engagement|monetization|performance)$/,
            }),
            subjectRef: nullableStringField({ minLength: 1, maxLength: 128 }),
            eventKind: stringField({ pattern: EVENT_KIND_PATTERN }),
            content: recordField({ maxDepthKeys: 64 }),
            observedAt: stringField({ pattern: ISO_TIMESTAMP_PATTERN }),
            quality: stringField({ pattern: /^[A-F]$/ }),
            metric: nullableObjectField({
              fields: {
                name: stringField({ minLength: 5, maxLength: 64 }),
                value: numberField(),
                unit: stringField({ minLength: 1, maxLength: 32 }),
                dimensions: recordField({ maxDepthKeys: 32 }),
                aggregationMethod: nullableStringField({ minLength: 1, maxLength: 64 }),
              },
            }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          workspaceId: string | null;
          subjectKind: 'audience' | 'conversation' | 'content' | 'engagement' | 'monetization' | 'performance';
          subjectRef: string | null;
          eventKind: string;
          content: Record<string, unknown>;
          observedAt: string;
          quality: string;
          metric: {
            name: string;
            value: number;
            unit: string;
            dimensions: Record<string, string | number | boolean>;
            aggregationMethod: string | null;
          } | null;
          idempotencyKey: string;
        };
        return pack.recordCreatorObservation(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            subjectKind: body.subjectKind,
            subjectRef: body.subjectRef ?? null,
            eventKind: body.eventKind,
            content: body.content,
            observedAt: body.observedAt,
            quality: body.quality,
            metric:
              body.metric === null
                ? null
                : {
                    // The module guard pins the closed creator metric-name
                    // vocabulary (the frozen mapping targets).
                    name: body.metric.name as never,
                    value: body.metric.value,
                    unit: body.metric.unit,
                    dimensions: body.metric.dimensions,
                    aggregationMethod: body.metric.aggregationMethod ?? null,
                  },
            idempotencyKey: body.idempotencyKey,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('creator_operations.observation.mapped', undefined, {
          client_id: ctx.params.clientId,
          evidence_id: ctx.result.evidenceId,
          observation_id: ctx.result.observationId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.observation.mapped',
          targetType: 'creator_observation',
          targetId: ctx.result.evidenceId,
          idempotencyKey: `creator_operations.observation.mapped:${ctx.result.evidenceId}`,
          details: {
            evidenceId: ctx.result.evidenceId,
            observationId: ctx.result.observationId,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          evidenceId: ctx.result.evidenceId,
          ...(ctx.result.observationId === null ? {} : { observationId: ctx.result.observationId }),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // Pack publication and TaskProfile provisioning
  // -------------------------------------------------------------------------

  // POST /api/creator-operations/publish — publish the FROZEN pack manifest
  // through the /domain-packs framework authority.
  router.add(
    'POST',
    '/api/creator-operations/publish',
    defineMutationRoute<Record<string, string>, { packId: string; version: string; packKey: string }>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requirePublisherRole(ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ idempotencyKey: string }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { idempotencyKey: string };
        const record = await pack.publishCreatorOperationsPack({
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          idempotencyKey: body.idempotencyKey,
        });
        return {
          packId: record.packId,
          version: record.manifest.version,
          packKey: record.manifest.packKey,
        };
      },
      emit: async (ctx) => {
        logger.info('creator_operations.pack.published', undefined, {
          pack_id: ctx.result.packId,
          version: ctx.result.version,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.pack.published',
          targetType: 'domain_pack_version',
          targetId: ctx.result.packId,
          idempotencyKey: `creator_operations.pack.published:${ctx.result.packId}`,
          details: { packKey: ctx.result.packKey, version: ctx.result.version },
        });
      },
      respond: (ctx) => jsonResponse(201, ctx.result),
    }),
  );

  // POST /api/workspaces/:workspaceId/creator-operations/task-profiles —
  // provision the pack's AI task classes as REAL TaskProfiles of the
  // /ai-runtime authority (consumed through the platform AI Router).
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/creator-operations/task-profiles',
    defineMutationRoute<
      { workspaceId: string },
      readonly { taskClass: string; taskProfileId: string; replayed: boolean }[]
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const ownership = await modules.workspaces.resolveWorkspaceOwnership(params.workspaceId);
        if (ownership === null) {
          throw new NotFoundError('workspace', params.workspaceId);
        }
        return {
          kind: 'workspace',
          agencyId: ownership.scope.agencyId,
          clientId: ownership.scope.clientId,
          workspaceId: ownership.scope.workspaceId,
        };
      },
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ idempotencyKey: string }>(ctx.request.body, {
          forbiddenKeys: CREATOR_AUTHORITY_FIELDS,
          fields: {
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { idempotencyKey: string };
        const owner = ctx.owner;
        if (owner.kind !== 'workspace') {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        return pack.provisionCreatorTaskProfiles({
          scope: {
            workspaceId: owner.workspaceId,
            clientId: owner.clientId,
            agencyId: owner.agencyId,
          },
          idempotencyKey: body.idempotencyKey,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('creator_operations.task_profiles.provisioned', undefined, {
          workspace_id: ctx.params.workspaceId,
          count: ctx.result.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'creator_operations.task_profiles.provisioned',
          targetType: 'workspace',
          targetId: ctx.params.workspaceId,
          details: {
            count: ctx.result.length,
            replays: ctx.result.filter((receipt) => receipt.replayed).length,
            taskClasses: ctx.result.map((receipt) => receipt.taskClass).sort().join(','),
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          workspaceId: ctx.params.workspaceId,
          taskProfiles: ctx.result,
        }),
    }),
  );

  // GET /api/creator-operations/manifest — the frozen manifest (pure read).
  router.add(
    'GET',
    '/api/creator-operations/manifest',
    defineQueryRoute<Record<string, string>, Record<string, unknown>>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      execute: async () => pack.getCreatorOperationsManifest() as unknown as Record<string, unknown>,
      respond: (ctx) => jsonResponse(200, ctx.result),
    }),
  );
}
