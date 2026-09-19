/**
 * /api/social-accounts/* routes (MKT-055 — the Social Account and OAuth
 * Connection Model: the provider-neutral OAuth flow surface + the
 * authorization reads).
 *
 *   POST  /api/clients/:clientId/social-accounts/authorize-start               the OAuth authorize-start round (owner|admin) — appends the PENDING grant, returns { authorizationId, state, authorizeUrl }
 *   POST  /api/clients/:clientId/social-accounts/complete                        the OAuth callback/complete (owner|admin) — correlates the round by state, exchanges the code, binds the identity
 *   POST  /api/clients/:clientId/social-accounts/:accountId/refresh             the token refresh (owner|admin) — appends the successor grant
 *   POST  /api/clients/:clientId/social-accounts/:accountId/reauthorize          the reauthorize round (owner|admin) — a fresh PENDING grant pre-bound to the account
 *   POST  /api/clients/:clientId/social-accounts/:accountId/disconnect          the operator disconnect (owner|admin) — the terminal fail-closed death
 *   POST  /api/clients/:clientId/social-accounts/:accountId/external-revocation records the externally-signalled revocation (owner|admin|service) — the terminal fail-closed death
 *
 *   GET   /api/clients/:clientId/social-accounts                                 the Client's bindings (any active member)
 *   GET   /api/clients/:clientId/social-accounts/:accountId                     one binding (member; uniform 404 for foreign/unknown)
 *   GET   /api/clients/:clientId/social-accounts/:accountId/grants              the account's grant tail (member) — REFUSES 409 on a disconnected/revoked connection
 *   GET   /api/clients/:clientId/social-accounts/:accountId/grants/:grantId      one grant (member) — REFUSES 409 on a disconnected/revoked connection or a revoked grant
 *   GET   /api/clients/:clientId/social-accounts/:accountId/events              the append-only history tail (member — audit)
 *   GET   /api/workspaces/:workspaceId/social-accounts                          the Workspace's bindings (member)
 *
 * There is deliberately NO update route (recorded authorization facts are
 * immutable — refresh/reauthorize are NEW records), NO delete route (the
 * grant history is append-only; the binding death is the DISCONNECT /
 * EXTERNAL-REVOCATION transition), and NO usable-authorization route:
 * getUsableAuthorization is the MODULE-LEVEL consumer surface for the
 * MKT-056+ adapters and server-side callers (the app-metering
 * module-command precedent — never an HTTP authorization oracle).
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: the DTOs reject
 * identity/ownership/lifecycle/provenance/scope-outcome fields AND every
 * material-shaped key (§21 — the state token and the authorization code
 * are the ONLY protocol inputs; the granted scopes and capability tags
 * arrive from the provider boundary INSIDE the module, never from the
 * request). The OAuth `code` is transient single-use protocol data: it
 * is never persisted, logged or audited (there is deliberately NO code
 * column anywhere in migration 046).
 *
 * Authorization follows the established hard-boundary posture: every
 * route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /clients chain; the account-scoped
 * routes additionally resolve the canonical account owner and yield a
 * UNIFORM 404 for unknown/foreign/mismatched identifiers — no cross-
 * tenant oracle), authorizes against the SAME /agencies membership
 * authority as every other scoped check (no second authorization
 * authority), and the provider egress + credential use stay behind the
 * module's fail-closed /policies gates.
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
  optionalArrayField,
  optionalString,
  stringField,
  validateObject,
  type FieldSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireClientAccess, requireWorkspaceAccess } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  SocialAccountEventRecord,
  SocialAccountProvenance,
  SocialAccountRecord,
  SocialGrantRecord,
} from '../modules/social-accounts/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_PATTERN = /^[\S].{0,254}$/;


/** The local OPTIONAL boolean field (the jobs-visits booleanField precedent). */
const optionalBooleanField: FieldSpec<boolean | undefined> = {
  required: false,
  parse: (value, problems) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      problems.push('must be a boolean');
      return undefined;
    }
    return value;
  },
};
/**
 * Fields always server-derived on the social-account surfaces — plus
 * every material-shaped key is rejected so nothing secret can even be
 * smuggled into a flow (§21: tokens reach the vault through the
 * provider-boundary handle, never a request field).
 */
const SOCIAL_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/lifecycle/outcome.
  'socialAccountId',
  'grantId',
  'authorizationId',
  'agencyId',
  'clientId',
  'workspaceId',
  'integrationConnectionId',
  'platformId',
  'externalAccountId',
  'displayIdentity',
  'verifiedAt',
  'status',
  'grantState',
  'stateToken',
  'credentialReferenceId',
  'credentialReference',
  'successorGrantId',
  'completedAt',
  'expiresAt',
  'version',
  'createdAt',
  'updatedAt',
  'grant',
  'scopeFacts',
  'grantedScopes',
  'capabilityTags',
  'authorizeUrl',
  'account',
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
  'tokenSecretHandle',
] as const;

/**
 * SERVER-DERIVED provenance for HTTP-surface social-account mutations:
 * actor from the authenticated principal, correlation from the ambient
 * correlation context, recording surface 'api'. No value in here is
 * reachable from the request body (every DTO rejects provenance-shaped
 * keys).
 */
function serverProvenance(principal: Principal): SocialAccountProvenance {
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

function serializeAccount(record: SocialAccountRecord): Record<string, unknown> {
  return {
    socialAccountId: record.socialAccountId,
    integrationConnectionId: record.integrationConnectionId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    ...(record.workspaceId === null ? {} : { workspaceId: record.workspaceId }),
    platformId: record.platformId,
    externalAccountId: record.externalAccountId,
    displayIdentity: record.displayIdentity,
    ...(record.verifiedAt === null ? {} : { verifiedAt: record.verifiedAt }),
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeGrant(record: SocialGrantRecord): Record<string, unknown> {
  return {
    grantId: record.grantId,
    integrationConnectionId: record.integrationConnectionId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    ...(record.socialAccountId === null
      ? {}
      : { socialAccountId: record.socialAccountId }),
    platformId: record.platformId,
    grantState: record.grantState,
    ...(record.requestedScopes === null
      ? {}
      : { requestedScopes: [...record.requestedScopes] }),
    ...(record.credentialReferenceId === null
      ? {}
      : { credentialReferenceId: record.credentialReferenceId }),
    ...(record.expiresAt === null ? {} : { expiresAt: record.expiresAt }),
    ...(record.successorGrantId === null
      ? {}
      : { successorGrantId: record.successorGrantId }),
    ...(record.completedAt === null ? {} : { completedAt: record.completedAt }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeEvent(record: SocialAccountEventRecord): Record<string, unknown> {
  return {
    eventId: record.eventId,
    ...(record.socialAccountId === null
      ? {}
      : { socialAccountId: record.socialAccountId }),
    ...(record.grantId === null ? {} : { grantId: record.grantId }),
    eventType: record.eventType,
    initiatedBy: record.initiatedBy,
    ...(record.reason === null ? {} : { reason: record.reason }),
    ...(record.providerRevokeOutcome === null
      ? {}
      : { providerRevokeOutcome: record.providerRevokeOutcome }),
    recordedActor: record.recordedActor,
    recordedVia: record.recordedVia,
    recordedAt: record.recordedAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSocialAccountsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('social-accounts.api');

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
   * The canonical ACCOUNT owner resolution for every account-scoped
   * route: the module resolves the binding + its integration connection
   * + the /clients chain; an account that does not exist, whose chain
   * does not resolve, or that belongs to ANOTHER Client than the path's
   * is the SAME uniform 404 (a foreign identifier is not a traversal
   * oracle).
   */
  async function requireAccountInClient(socialAccountId: string, clientId: string) {
    if (!UUID_PATTERN.test(socialAccountId)) {
      throw new NotFoundError('social account', socialAccountId);
    }
    const ownership = await modules.socialAccounts.resolveAccountOwnership(socialAccountId);
    if (ownership === null || ownership.account.clientId !== clientId) {
      throw new NotFoundError('social account', socialAccountId);
    }
    return ownership;
  }

  // -------------------------------------------------------------------------
  // The OAuth flow surface (the provider-neutral connect flow)
  // -------------------------------------------------------------------------

  // POST /api/clients/:clientId/social-accounts/authorize-start — the
  // authorize-start round: appends the PENDING grant (state token +
  // requested scopes as INTENT) and returns the authorize URL the
  // operator's browser is redirected to.
  router.add(
    'POST',
    '/api/clients/:clientId/social-accounts/authorize-start',
    defineMutationRoute<
      { clientId: string },
      { readonly grant: SocialGrantRecord; readonly authorizeUrl: string }
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
        validateObject<{
          connectionId: string;
          workspaceId?: string;
          requestedScopes?: string[];
        }>(ctx.request.body, {
          forbiddenKeys: SOCIAL_AUTHORITY_FIELDS,
          fields: {
            connectionId: stringField({ minLength: 1, maxLength: 64 }),
            workspaceId: optionalString({ minLength: 1, maxLength: 64 }),
            requestedScopes: optionalArrayField({
              minItems: 1,
              maxItems: 64,
              item: stringField({ pattern: SCOPE_PATTERN }),
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          connectionId: string;
          workspaceId?: string;
          requestedScopes?: string[];
        };
        return modules.socialAccounts.startAuthorization(
          {
            clientId: ctx.params.clientId,
            integrationConnectionId: body.connectionId,
            workspaceId: body.workspaceId ?? null,
            requestedScopes: body.requestedScopes ?? null,
            expectedAccountId: null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('social_accounts.authorization_started', undefined, {
          client_id: ctx.params.clientId,
          grant_id: ctx.result.grant.grantId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'social_accounts.authorization_started',
          targetType: 'social_account_grant',
          targetId: ctx.result.grant.grantId,
          idempotencyKey: `social_accounts.authorization_started:${ctx.result.grant.grantId}`,
          details: {
            grantState: ctx.result.grant.grantState,
            platformId: ctx.result.grant.platformId,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          authorizationId: ctx.result.grant.grantId,
          state: ctx.result.grant.stateToken,
          authorizeUrl: ctx.result.authorizeUrl,
          grant: serializeGrant(ctx.result.grant),
        }),
    }),
  );

  // POST /api/clients/:clientId/social-accounts/complete — the OAuth
  // callback/complete: correlates the round by the OPAQUE state token,
  // exchanges the code through the flow implementation and binds the
  // account identity (idempotent reconnect; conflicting bindings are
  // rejected fail-closed).
  router.add(
    'POST',
    '/api/clients/:clientId/social-accounts/complete',
    defineMutationRoute<
      { clientId: string },
      {
        readonly account: SocialAccountRecord;
        readonly grant: SocialGrantRecord;
        readonly scopeFacts: { readonly grantedScopes: readonly string[]; readonly capabilityTags: readonly string[] };
      }
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
        validateObject<{
          state: string;
          code: string;
        }>(ctx.request.body, {
          forbiddenKeys: SOCIAL_AUTHORITY_FIELDS,
          fields: {
            state: stringField({ minLength: 1, maxLength: 128 }),
            code: stringField({ minLength: 1, maxLength: 4096 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { state: string; code: string };
        return modules.socialAccounts.completeAuthorization(
          {
            clientId: ctx.params.clientId,
            state: body.state,
            code: body.code,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('social_accounts.authorization_completed', undefined, {
          client_id: ctx.params.clientId,
          social_account_id: ctx.result.account.socialAccountId,
          grant_id: ctx.result.grant.grantId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'social_accounts.authorization_completed',
          targetType: 'social_account_grant',
          targetId: ctx.result.grant.grantId,
          idempotencyKey: `social_accounts.authorization_completed:${ctx.result.grant.grantId}`,
          details: {
            socialAccountId: ctx.result.account.socialAccountId,
            grantState: ctx.result.grant.grantState,
            platformId: ctx.result.grant.platformId,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          account: serializeAccount(ctx.result.account),
          grant: serializeGrant(ctx.result.grant),
          grantedScopes: [...ctx.result.scopeFacts.grantedScopes],
          capabilityTags: [...ctx.result.scopeFacts.capabilityTags],
        }),
    }),
  );

  // POST /api/clients/:clientId/social-accounts/:accountId/refresh — the
  // token refresh: appends the successor grant (its own new vault
  // reference + verbatim scope records) while the old grant moves to
  // 'refreshed' with the successor link.
  router.add(
    'POST',
    '/api/clients/:clientId/social-accounts/:accountId/refresh',
    defineMutationRoute<
      { clientId: string; accountId: string },
      {
        readonly account: SocialAccountRecord;
        readonly grant: SocialGrantRecord;
        readonly scopeFacts: { readonly grantedScopes: readonly string[]; readonly capabilityTags: readonly string[] };
      }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        await clientOwner(params.clientId);
        const ownership = await requireAccountInClient(params.accountId, params.clientId);
        return {
          kind: 'client' as const,
          agencyId: ownership.account.agencyId,
          clientId: ownership.account.clientId,
        };
      },
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
        await requireAccountInClient(ctx.params.accountId, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: SOCIAL_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        return modules.socialAccounts.refreshAuthorization(
          { socialAccountId: ctx.params.accountId },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('social_accounts.authorization_refreshed', undefined, {
          client_id: ctx.params.clientId,
          social_account_id: ctx.result.account.socialAccountId,
          grant_id: ctx.result.grant.grantId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'social_accounts.authorization_refreshed',
          targetType: 'social_account_grant',
          targetId: ctx.result.grant.grantId,
          idempotencyKey: `social_accounts.authorization_refreshed:${ctx.result.grant.grantId}`,
          details: {
            socialAccountId: ctx.result.account.socialAccountId,
            grantState: ctx.result.grant.grantState,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          account: serializeAccount(ctx.result.account),
          grant: serializeGrant(ctx.result.grant),
          grantedScopes: [...ctx.result.scopeFacts.grantedScopes],
          capabilityTags: [...ctx.result.scopeFacts.capabilityTags],
        }),
    }),
  );

  // POST /api/clients/:clientId/social-accounts/:accountId/reauthorize —
  // the reauthorize round: a fresh PENDING grant pre-bound to the
  // account (the recovery path of an expired/aging authorization).
  router.add(
    'POST',
    '/api/clients/:clientId/social-accounts/:accountId/reauthorize',
    defineMutationRoute<
      { clientId: string; accountId: string },
      { readonly grant: SocialGrantRecord; readonly authorizeUrl: string }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        await clientOwner(params.clientId);
        const ownership = await requireAccountInClient(params.accountId, params.clientId);
        return {
          kind: 'client' as const,
          agencyId: ownership.account.agencyId,
          clientId: ownership.account.clientId,
        };
      },
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
        await requireAccountInClient(ctx.params.accountId, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<{ requestedScopes?: string[] }>(ctx.request.body, {
          forbiddenKeys: SOCIAL_AUTHORITY_FIELDS,
          fields: {
            requestedScopes: optionalArrayField({
              minItems: 1,
              maxItems: 64,
              item: stringField({ pattern: SCOPE_PATTERN }),
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { requestedScopes?: string[] };
        return modules.socialAccounts.startAuthorization(
          {
            clientId: ctx.params.clientId,
            integrationConnectionId: (
              await requireAccountInClient(ctx.params.accountId, ctx.params.clientId)
            ).account.integrationConnectionId,
            workspaceId: null,
            requestedScopes: body.requestedScopes ?? null,
            expectedAccountId: ctx.params.accountId,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('social_accounts.authorization_reauthorize_started', undefined, {
          client_id: ctx.params.clientId,
          social_account_id: ctx.params.accountId,
          grant_id: ctx.result.grant.grantId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'social_accounts.authorization_reauthorize_started',
          targetType: 'social_account_grant',
          targetId: ctx.result.grant.grantId,
          idempotencyKey: `social_accounts.authorization_reauthorize_started:${ctx.result.grant.grantId}`,
          details: {
            socialAccountId: ctx.params.accountId,
            grantState: ctx.result.grant.grantState,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          authorizationId: ctx.result.grant.grantId,
          state: ctx.result.grant.stateToken,
          authorizeUrl: ctx.result.authorizeUrl,
          grant: serializeGrant(ctx.result.grant),
        }),
    }),
  );

  // POST /api/clients/:clientId/social-accounts/:accountId/disconnect —
  // the operator disconnect: the terminal fail-closed death (every
  // authorization-bearing read refuses from here on; the vault
  // references die — no zombie grants).
  router.add(
    'POST',
    '/api/clients/:clientId/social-accounts/:accountId/disconnect',
    defineMutationRoute<{ clientId: string; accountId: string }, SocialAccountRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        await clientOwner(params.clientId);
        const ownership = await requireAccountInClient(params.accountId, params.clientId);
        return {
          kind: 'client' as const,
          agencyId: ownership.account.agencyId,
          clientId: ownership.account.clientId,
        };
      },
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
        await requireAccountInClient(ctx.params.accountId, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<{ reason?: string; revokeAtProvider?: boolean }>(ctx.request.body, {
          forbiddenKeys: SOCIAL_AUTHORITY_FIELDS,
          fields: {
            reason: optionalString({ minLength: 1, maxLength: 2000 }),
            revokeAtProvider: optionalBooleanField,
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { reason?: string; revokeAtProvider?: boolean };
        return modules.socialAccounts.disconnectAccount(
          {
            socialAccountId: ctx.params.accountId,
            reason: body.reason ?? null,
            revokeAtProvider: body.revokeAtProvider ?? false,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('social_accounts.account_disconnected', undefined, {
          client_id: ctx.params.clientId,
          social_account_id: ctx.result.socialAccountId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'social_accounts.account_disconnected',
          targetType: 'social_account',
          targetId: ctx.result.socialAccountId,
          idempotencyKey: `social_accounts.account_disconnected:${ctx.result.socialAccountId}:${ctx.result.updatedAt}`,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeAccount(ctx.result)),
    }),
  );

  // POST /api/clients/:clientId/social-accounts/:accountId/external-revocation —
  // records the externally-signalled revocation (the provider/platform
  // revoked the authorization): the terminal fail-closed death, identical
  // failure modes to the operator disconnect. Server-side relays (the
  // service principal) and platform administrators may record the signal
  // for any client; agency members need owner|admin (fail-closed kill
  // authority, never a grant).
  router.add(
    'POST',
    '/api/clients/:clientId/social-accounts/:accountId/external-revocation',
    defineMutationRoute<{ clientId: string; accountId: string }, SocialAccountRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        await clientOwner(params.clientId);
        const ownership = await requireAccountInClient(params.accountId, params.clientId);
        return {
          kind: 'client' as const,
          agencyId: ownership.account.agencyId,
          clientId: ownership.account.clientId,
        };
      },
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
        await requireAccountInClient(ctx.params.accountId, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<{ reason?: string; signalledVia: string }>(ctx.request.body, {
          forbiddenKeys: SOCIAL_AUTHORITY_FIELDS,
          fields: {
            reason: optionalString({ minLength: 1, maxLength: 2000 }),
            signalledVia: stringField({ minLength: 1, maxLength: 64, pattern: /^[a-z0-9][a-z0-9._:-]{0,63}$/ }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { reason?: string; signalledVia: string };
        return modules.socialAccounts.recordExternalRevocation(
          {
            socialAccountId: ctx.params.accountId,
            reason: body.reason ?? null,
            signalledVia: body.signalledVia,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('social_accounts.account_externally_revoked', undefined, {
          client_id: ctx.params.clientId,
          social_account_id: ctx.result.socialAccountId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'social_accounts.account_externally_revoked',
          targetType: 'social_account',
          targetId: ctx.result.socialAccountId,
          idempotencyKey: `social_accounts.account_externally_revoked:${ctx.result.socialAccountId}:${ctx.result.updatedAt}`,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeAccount(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // The reads
  // -------------------------------------------------------------------------

  // GET /api/clients/:clientId/social-accounts — the Client's bindings.
  router.add(
    'GET',
    '/api/clients/:clientId/social-accounts',
    defineQueryRoute<{ clientId: string }, readonly SocialAccountRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.socialAccounts.listSocialAccountsForClient(ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          socialAccounts: ctx.result.map(serializeAccount),
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/social-accounts — the Workspace's
  // bindings (the workspace-narrowed slice).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/social-accounts',
    defineQueryRoute<{ workspaceId: string }, readonly SocialAccountRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) =>
        modules.socialAccounts.listSocialAccountsForWorkspace(ctx.params.workspaceId),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          socialAccounts: ctx.result.map(serializeAccount),
        }),
    }),
  );

  // GET /api/clients/:clientId/social-accounts/:accountId — one binding
  // (the status is the visible fact; the account record carries no
  // authorization payload).
  router.add(
    'GET',
    '/api/clients/:clientId/social-accounts/:accountId',
    defineQueryRoute<{ clientId: string; accountId: string }, SocialAccountRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
        await requireAccountInClient(ctx.params.accountId, ctx.params.clientId);
      },
      execute: async (ctx) => {
        const account = await modules.socialAccounts.getSocialAccount(ctx.params.accountId);
        if (account === null) {
          throw new NotFoundError('social account', ctx.params.accountId);
        }
        return account;
      },
      respond: (ctx) => jsonResponse(200, serializeAccount(ctx.result)),
    }),
  );

  // GET /api/clients/:clientId/social-accounts/:accountId/grants — the
  // account's grant tail (the authorization history). REFUSES 409 when
  // the connection is disconnected/revoked (MKT-055 AC-5: every read of
  // a disconnected/revoked connection's grant refuses).
  router.add(
    'GET',
    '/api/clients/:clientId/social-accounts/:accountId/grants',
    defineQueryRoute<{ clientId: string; accountId: string }, readonly SocialGrantRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
        await requireAccountInClient(ctx.params.accountId, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.socialAccounts.listAuthorizationGrantsForAccount(ctx.params.accountId),
      respond: (ctx) =>
        jsonResponse(200, {
          socialAccountId: ctx.params.accountId,
          grants: ctx.result.map(serializeGrant),
        }),
    }),
  );

  // GET /api/clients/:clientId/social-accounts/:accountId/grants/:grantId —
  // one grant with its VERBATIM scope records + capability tags. The
  // same 409 refusal contract on dead connections/grants.
  router.add(
    'GET',
    '/api/clients/:clientId/social-accounts/:accountId/grants/:grantId',
    defineQueryRoute<
      { clientId: string; accountId: string; grantId: string },
      { grant: SocialGrantRecord; grantedScopes: readonly string[]; capabilityTags: readonly string[] }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
        await requireAccountInClient(ctx.params.accountId, ctx.params.clientId);
      },
      execute: async (ctx) => {
        const grant = await modules.socialAccounts.getAuthorizationGrant(ctx.params.grantId);
        if (grant.socialAccountId !== ctx.params.accountId) {
          throw new NotFoundError('authorization grant', ctx.params.grantId);
        }
        const scopeFacts = await modules.socialAccounts.getAuthorizationGrantScopeFacts(
          ctx.params.grantId,
        );
        return {
          grant,
          grantedScopes: scopeFacts.grantedScopes,
          capabilityTags: scopeFacts.capabilityTags,
        };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          grant: serializeGrant(ctx.result.grant),
          grantedScopes: [...ctx.result.grantedScopes],
          capabilityTags: [...ctx.result.capabilityTags],
        }),
    }),
  );

  // GET /api/clients/:clientId/social-accounts/:accountId/events — the
  // append-only history tail of the account (always readable — audit;
  // the events carry NO authorization payload: no credential reference,
  // no token facts).
  router.add(
    'GET',
    '/api/clients/:clientId/social-accounts/:accountId/events',
    defineQueryRoute<{ clientId: string; accountId: string }, readonly SocialAccountEventRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
        await requireAccountInClient(ctx.params.accountId, ctx.params.clientId);
      },
      execute: async (ctx) => modules.socialAccounts.listAccountEvents(ctx.params.accountId),
      respond: (ctx) =>
        jsonResponse(200, {
          socialAccountId: ctx.params.accountId,
          events: ctx.result.map(serializeEvent),
        }),
    }),
  );
}
