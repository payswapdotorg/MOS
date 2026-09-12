/**
 * /integrations API routes (MKT-023 — Provider integration boundary:
 * INT-001, the generic integration ports + first-party adapter mechanism).
 *
 *   GET   /api/integrations/adapters                                   the ADAPTER REGISTRY as data (descriptors + capabilities — no tenant data)
 *
 *   POST  /api/clients/:clientId/connections                           register a connection (owner|admin of the owning agency|platform admin)
 *   GET   /api/clients/:clientId/connections                           the Client's connections, newest first (any active member of the owning agency)
 *   GET   /api/clients/:clientId/connections/:connectionId            read one connection (member; uniform 404 for foreign/unknown)
 *   POST  /api/clients/:clientId/connections/:connectionId/connect    the policy-gated connect probe (owner|admin) — CAS transition
 *   POST  /api/clients/:clientId/connections/:connectionId/suspend    the administrative pause (owner|admin) — CAS transition
 *   POST  /api/clients/:clientId/connections/:connectionId/read       one normalized READ through the adapter port (any active member —
 *                                                                       the /policies engine is the egress authority)
 *   POST  /api/clients/:clientId/connections/:connectionId/mutate     one normalized MUTATION through the adapter port (owner|admin)
 *   POST  /api/clients/:clientId/connections/:connectionId/webhook    ingest one webhook delivery (any active member/service — the
 *                                                                       authenticated relay surface; the ADAPTER verifies authenticity)
 *   GET   /api/clients/:clientId/integration-events                   the Client's ingested events, newest first (member)
 *   GET   /api/integration-events/:eventId                            read one ingested event (member of the owning agency; uniform 404)
 *
 * There is deliberately NO connection delete or disconnect-forever route:
 * the frozen connection lifecycle has NO terminal state (a connection is
 * operational plumbing — suspend + reconnect), and the ingested-event
 * ledger is append-only (no update, no delete routes).
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: connection DTOs reject
 * identity/ownership/lifecycle/provenance fields AND every material-shaped
 * key (§21 — a connection references its credential by LOGICAL NAME; the
 * material resolves only in-process after a fail-closed /policies allow);
 * execution DTOs additionally reject health/rate-limit/policy-decision
 * outcome fields; webhook DTOs reject evidence/provenance fields (the
 * derived 'source_fact' /evidence observation is appended server-side
 * with pinned class/quality/provenance). Outcomes, provenance and the
 * provider-touching decisions are derived server-side
 * (implementation-contract §3).
 *
 * Authorization follows the established hard-boundary posture: every
 * route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /clients canonical ownership chain; the
 * connection routes additionally resolve the canonical connection owner
 * and yield a UNIFORM 404 for unknown/foreign/mismatched identifiers —
 * no cross-tenant oracle), authorizes against the SAME /agencies
 * membership authority as every other scoped check (no second
 * authorization authority), and delegates provider egress + credential
 * use to the module's fail-closed /policies gate (network dimension:
 * integration.connect/read/mutate; secrets dimension:
 * integration.credential/webhook).
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
  intField,
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireClientAccess, resolveContext } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  IntegrationConnectionRecord,
  IntegrationIngestedEventRecord,
  IntegrationMutationOutcome,
  IntegrationProvenance,
  IntegrationReadOutcome,
  RegisteredAdapterInfo,
} from '../modules/integrations/public.ts';

const ADAPTER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Fields always server-derived on registration — plus every
 * material-shaped key is rejected so nothing secret can even be smuggled
 * into a connection record (§21: connections reference credentials by
 * logical name, never material).
 */
const CONNECTION_REGISTER_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/lifecycle/bookkeeping.
  'connectionId',
  'clientId',
  'agencyId',
  'providerLabel',
  'status',
  'health',
  'rateLimit',
  'lastError',
  'lastCheckedAt',
  'version',
  'createdAt',
  'updatedAt',
  'createdBy',
  'evidenceRef',
  // Provenance is SERVER-DERIVED — never a request field.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'receivedAt',
  // Material-shaped keys are rejected outright on every integrations surface.
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
 * Fields always server-derived on the CAS lifecycle transitions (connect/
 * suspend): the outcome state (status, health, rate limit, last error) is
 * computed by the module from the ADAPTER PROBE, never supplied.
 */
const CONNECTION_TRANSITION_AUTHORITY_FIELDS = [
  'connectionId',
  'clientId',
  'agencyId',
  'adapterKey',
  'providerLabel',
  'status',
  'health',
  'rateLimit',
  'lastError',
  'lastCheckedAt',
  'version',
  'createdAt',
  'updatedAt',
  'createdBy',
  'evidenceRef',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'receivedAt',
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
 * Fields always server-derived on provider EXECUTION (read/mutation): the
 * normalized outcome, the observed health/rate-limit state and the recorded
 * policy decision identity. The caller supplies only the operation + its
 * parameters.
 */
const CONNECTION_EXECUTE_AUTHORITY_FIELDS = [
  'connectionId',
  'clientId',
  'agencyId',
  'adapterKey',
  'providerLabel',
  'status',
  'health',
  'rateLimit',
  'lastError',
  'lastCheckedAt',
  'version',
  'createdAt',
  'updatedAt',
  'createdBy',
  'ok',
  'records',
  'providerRecordId',
  'data',
  'error',
  'policyDecisionId',
  'connection',
  'evidenceRef',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'receivedAt',
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
 * Fields always server-derived on webhook INGESTION: the event identity,
 * the evidence reference and the whole provenance block — a caller can
 * never supply any of them (the verified event, its derived 'source_fact'
 * evidence observation and the provenance are computed and recorded
 * server-side, exactly as the implementation contract §3 demands).
 */
const WEBHOOK_INGEST_AUTHORITY_FIELDS = [
  'eventId',
  'connectionId',
  'clientId',
  'agencyId',
  'adapterKey',
  'normalizedEventType',
  'verified',
  'reason',
  'evidenceRef',
  'evidenceId',
  'class',
  'quality',
  'confidence',
  'observedAt',
  'receivedAt',
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
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/**
 * SERVER-DERIVED provenance for HTTP-surface integration mutations: actor
 * from the authenticated principal, correlation from the ambient
 * correlation context, recording surface 'api'. No value in here is
 * reachable from the request body (every DTO rejects provenance-shaped
 * keys).
 */
function serverProvenance(principal: Principal): IntegrationProvenance {
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

function serializeConnection(record: IntegrationConnectionRecord): Record<string, unknown> {
  return {
    connectionId: record.connectionId,
    clientId: record.clientId,
    agencyId: record.agencyId,
    adapterKey: record.adapterKey,
    providerLabel: record.providerLabel,
    status: record.status,
    health: record.health,
    credentialReferenceId: record.credentialReferenceId,
    providerConfig: record.providerConfig,
    ...(record.rateLimit === null ? {} : { rateLimit: record.rateLimit }),
    ...(record.lastError === null ? {} : { lastError: record.lastError }),
    ...(record.lastCheckedAt === null ? {} : { lastCheckedAt: record.lastCheckedAt }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeAdapter(info: RegisteredAdapterInfo): Record<string, unknown> {
  return {
    adapterKey: info.descriptor.adapterKey,
    providerLabel: info.descriptor.providerLabel,
    description: info.descriptor.description,
    capabilities: info.capabilities.map((capability) => ({
      capabilityKey: capability.capabilityKey,
      kind: capability.kind,
      operations: [...capability.operations],
      description: capability.description,
    })),
  };
}

function serializeEvent(record: IntegrationIngestedEventRecord): Record<string, unknown> {
  return {
    eventId: record.eventId,
    connectionId: record.connectionId,
    clientId: record.clientId,
    adapterKey: record.adapterKey,
    eventType: record.eventType,
    payload: record.payload,
    ...(record.evidenceRef === null ? {} : { evidenceRef: record.evidenceRef }),
    provenance: {
      actor: record.provenance.actor,
      recordedVia: record.provenance.recordedVia,
      correlationId: record.provenance.correlationId,
      ...(record.provenance.causationId === null
        ? {}
        : { causationId: record.provenance.causationId }),
      receivedAt: record.provenance.receivedAt,
    },
  };
}

function serializeReadOutcome(outcome: IntegrationReadOutcome): Record<string, unknown> {
  return {
    connectionId: outcome.connectionId,
    adapterKey: outcome.adapterKey,
    operation: outcome.operation,
    ok: outcome.ok,
    records: outcome.records.map((record) => ({
      providerRecordId: record.providerRecordId,
      data: record.data,
      ...(record.sourceTimestamp === null ? {} : { sourceTimestamp: record.sourceTimestamp }),
      ...(record.etag === null ? {} : { etag: record.etag }),
      ...(record.sourceVersion === null ? {} : { sourceVersion: record.sourceVersion }),
    })),
    ...(outcome.error === null ? {} : { error: outcome.error }),
    ...(outcome.rateLimit === null ? {} : { rateLimit: outcome.rateLimit }),
    policyDecisionId: outcome.policyDecisionId,
    connection: serializeConnection(outcome.connection),
  };
}

function serializeMutationOutcome(outcome: IntegrationMutationOutcome): Record<string, unknown> {
  return {
    connectionId: outcome.connectionId,
    adapterKey: outcome.adapterKey,
    operation: outcome.operation,
    ok: outcome.ok,
    ...(outcome.providerRecordId === null ? {} : { providerRecordId: outcome.providerRecordId }),
    ...(outcome.data === null ? {} : { data: outcome.data }),
    ...(outcome.error === null ? {} : { error: outcome.error }),
    ...(outcome.rateLimit === null ? {} : { rateLimit: outcome.rateLimit }),
    policyDecisionId: outcome.policyDecisionId,
    connection: serializeConnection(outcome.connection),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerIntegrationsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('integrations.api');

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
   * The canonical CONNECTION owner resolution for every connection-scoped
   * route: the module resolves the connection + its owning Client chain;
   * a connection that does not exist, whose Client chain does not resolve,
   * or that belongs to ANOTHER Client than the path's is the SAME uniform
   * 404 (a foreign identifier is not a traversal oracle).
   */
  async function requireConnectionInClient(connectionId: string, clientId: string) {
    const ownership = await modules.integrations.resolveConnectionOwnership(connectionId);
    if (ownership === null || ownership.connection.clientId !== clientId) {
      throw new NotFoundError('integration connection', connectionId);
    }
    return ownership;
  }

  // -------------------------------------------------------------------------
  // The adapter registry (the capability-discovery surface — DATA)
  // -------------------------------------------------------------------------

  // GET /api/integrations/adapters — every registered adapter's descriptor
  // + capabilities. The registry content is injected module data (the
  // composition-root first-party registration surface): provider-neutral
  // descriptors with NO tenant data, so any active identity (or the
  // internal service principal) may read it. This is the capability-
  // discovery surface callers use to pick an adapterKey and an operation.
  router.add(
    'GET',
    '/api/integrations/adapters',
    defineQueryRoute<Record<string, string>, readonly RegisteredAdapterInfo[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active identity required');
        }
      },
      execute: async () => modules.integrations.listRegisteredAdapters(),
      respond: (ctx) =>
        jsonResponse(200, {
          adapters: ctx.result.map(serializeAdapter),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // Connection registration + reads
  // -------------------------------------------------------------------------

  // POST /api/clients/:clientId/connections — register a connection (the
  // born state 'registered'). Client ownership + adapter registry +
  // credential-reference scope are all resolved canonically INSIDE the
  // module (unknown/foreign → uniform 404; inactive → 409).
  router.add(
    'POST',
    '/api/clients/:clientId/connections',
    defineMutationRoute<{ clientId: string }, IntegrationConnectionRecord>({
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
          adapterKey: string;
          credentialReferenceId: string;
          providerConfig: Record<string, unknown>;
        }>(ctx.request.body, {
          forbiddenKeys: CONNECTION_REGISTER_AUTHORITY_FIELDS,
          fields: {
            adapterKey: stringField({ pattern: ADAPTER_KEY_PATTERN }),
            credentialReferenceId: stringField({ minLength: 1, maxLength: 64 }),
            providerConfig: recordField({ maxDepthKeys: 32 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { adapterKey: string; credentialReferenceId: string; providerConfig: Record<string, unknown> };
        return modules.integrations.registerConnection(
          {
            clientId: ctx.params.clientId,
            adapterKey: body.adapterKey,
            credentialReferenceId: body.credentialReferenceId,
            providerConfig: body.providerConfig as Record<string, string>,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('integrations.connection.registered', undefined, {
          connection_id: ctx.result.connectionId,
          client_id: ctx.params.clientId,
          adapter_key: ctx.result.adapterKey,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'integrations.connection.registered',
          targetType: 'integration_connection',
          targetId: ctx.result.connectionId,
          idempotencyKey: `integrations.connection.registered:${ctx.result.connectionId}`,
          afterVersion: ctx.result.version,
          details: {
            adapterKey: ctx.result.adapterKey,
            status: ctx.result.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeConnection(ctx.result)),
    }),
  );

  // GET /api/clients/:clientId/connections — the Client's connections,
  // newest first (operational state is always readable for members of the
  // owning agency; a foreign Client is a uniform 404).
  router.add(
    'GET',
    '/api/clients/:clientId/connections',
    defineQueryRoute<{ clientId: string }, readonly IntegrationConnectionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => modules.integrations.listConnectionsForClient(ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          connections: ctx.result.map(serializeConnection),
        }),
    }),
  );

  // GET /api/clients/:clientId/connections/:connectionId — read one
  // connection. The canonical connection owner context resolves inside
  // execute; a foreign/unknown connection id under this Client's path is
  // the SAME uniform 404 (no cross-tenant oracle).
  router.add(
    'GET',
    '/api/clients/:clientId/connections/:connectionId',
    defineQueryRoute<
      { clientId: string; connectionId: string },
      IntegrationConnectionRecord
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        const ownership = await requireConnectionInClient(
          ctx.params.connectionId,
          ctx.params.clientId,
        );
        return ownership.connection;
      },
      respond: (ctx) => jsonResponse(200, serializeConnection(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // The connection lifecycle (CAS transitions)
  // -------------------------------------------------------------------------

  // POST /api/clients/:clientId/connections/:connectionId/connect — the
  // CONNECT/RESUME transition: the module's fail-closed /policies gate
  // (network dimension) runs BEFORE any credential resolution or provider
  // probe; a healthy probe transitions to connected/healthy, an
  // unreachable one to error/unreachable (the outcome state is
  // server-computed from the probe — never request-suppliable).
  router.add(
    'POST',
    '/api/clients/:clientId/connections/:connectionId/connect',
    defineMutationRoute<{ clientId: string; connectionId: string }, IntegrationConnectionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ expectedVersion: number }>(ctx.request.body, {
          forbiddenKeys: CONNECTION_TRANSITION_AUTHORITY_FIELDS,
          fields: {
            expectedVersion: intField({ min: 1 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { expectedVersion: number };
        return modules.integrations.connectConnection(
          {
            connectionId: ctx.params.connectionId,
            expectedVersion: body.expectedVersion,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('integrations.connection.connected', undefined, {
          connection_id: ctx.result.connectionId,
          client_id: ctx.params.clientId,
          status: ctx.result.status,
          health: ctx.result.health,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'integrations.connection.connected',
          targetType: 'integration_connection',
          targetId: ctx.result.connectionId,
          idempotencyKey: `integrations.connection.connected:${ctx.result.connectionId}:${ctx.result.version}`,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          details: {
            status: ctx.result.status,
            health: ctx.result.health,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeConnection(ctx.result)),
    }),
  );

  // POST /api/clients/:clientId/connections/:connectionId/suspend — the
  // administrative SUSPEND transition (pure bookkeeping: no provider call,
  // no policy gate, no credential resolution — the operational pause).
  router.add(
    'POST',
    '/api/clients/:clientId/connections/:connectionId/suspend',
    defineMutationRoute<{ clientId: string; connectionId: string }, IntegrationConnectionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ expectedVersion: number; reason?: string }>(ctx.request.body, {
          forbiddenKeys: CONNECTION_TRANSITION_AUTHORITY_FIELDS,
          fields: {
            expectedVersion: intField({ min: 1 }),
            reason: optionalString({ minLength: 1, maxLength: 2000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { expectedVersion: number; reason?: string };
        return modules.integrations.suspendConnection(
          {
            connectionId: ctx.params.connectionId,
            reason: body.reason === undefined ? null : body.reason,
            expectedVersion: body.expectedVersion,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('integrations.connection.suspended', undefined, {
          connection_id: ctx.result.connectionId,
          client_id: ctx.params.clientId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'integrations.connection.suspended',
          targetType: 'integration_connection',
          targetId: ctx.result.connectionId,
          idempotencyKey: `integrations.connection.suspended:${ctx.result.connectionId}:${ctx.result.version}`,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          details: {
            status: ctx.result.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeConnection(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // Provider execution (the normalized adapter port surface)
  // -------------------------------------------------------------------------

  // POST /api/clients/:clientId/connections/:connectionId/read — one
  // normalized READ operation through the adapter port. The module runs
  // the full fail-closed gate (ownership → live state → capability
  // discovery → network-dimension policy → secrets-dimension policy →
  // credential material resolution → the adapter read); the outcome is
  // DATA (adapters never throw invocation failures) with the recorded
  // policy decision and the post-bookkeeping connection state.
  router.add(
    'POST',
    '/api/clients/:clientId/connections/:connectionId/read',
    defineMutationRoute<
      { clientId: string; connectionId: string },
      IntegrationReadOutcome
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<{
          operation: string;
          parameters: Record<string, unknown>;
        }>(ctx.request.body, {
          forbiddenKeys: CONNECTION_EXECUTE_AUTHORITY_FIELDS,
          fields: {
            operation: stringField({ minLength: 1, maxLength: 64 }),
            parameters: recordField({ maxDepthKeys: 32 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { operation: string; parameters: Record<string, unknown> };
        return modules.integrations.executeRead(
          {
            connectionId: ctx.params.connectionId,
            operation: body.operation,
            parameters: body.parameters,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('integrations.connection.read', undefined, {
          connection_id: ctx.params.connectionId,
          client_id: ctx.params.clientId,
          adapter_key: ctx.result.adapterKey,
          operation: ctx.result.operation,
          ok: ctx.result.ok,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'integrations.connection.read',
          targetType: 'integration_connection',
          targetId: ctx.params.connectionId,
          idempotencyKey: `integrations.connection.read:${ctx.result.policyDecisionId}`,
          details: {
            adapterKey: ctx.result.adapterKey,
            operation: ctx.result.operation,
            ok: ctx.result.ok,
            policyDecisionId: ctx.result.policyDecisionId,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeReadOutcome(ctx.result)),
    }),
  );

  // POST /api/clients/:clientId/connections/:connectionId/mutate — one
  // normalized MUTATION operation through the adapter port (side-effecting:
  // restricted to owner|admin; the module's fail-closed gate + the
  // normalized outcome + decision trail are the audit surface).
  router.add(
    'POST',
    '/api/clients/:clientId/connections/:connectionId/mutate',
    defineMutationRoute<
      { clientId: string; connectionId: string },
      IntegrationMutationOutcome
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
          operation: string;
          parameters: Record<string, unknown>;
        }>(ctx.request.body, {
          forbiddenKeys: CONNECTION_EXECUTE_AUTHORITY_FIELDS,
          fields: {
            operation: stringField({ minLength: 1, maxLength: 64 }),
            parameters: recordField({ maxDepthKeys: 32 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { operation: string; parameters: Record<string, unknown> };
        return modules.integrations.executeMutation(
          {
            connectionId: ctx.params.connectionId,
            operation: body.operation,
            parameters: body.parameters,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('integrations.connection.mutated', undefined, {
          connection_id: ctx.params.connectionId,
          client_id: ctx.params.clientId,
          adapter_key: ctx.result.adapterKey,
          operation: ctx.result.operation,
          ok: ctx.result.ok,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'integrations.connection.mutated',
          targetType: 'integration_connection',
          targetId: ctx.params.connectionId,
          idempotencyKey: `integrations.connection.mutated:${ctx.result.policyDecisionId}`,
          details: {
            adapterKey: ctx.result.adapterKey,
            operation: ctx.result.operation,
            ok: ctx.result.ok,
            policyDecisionId: ctx.result.policyDecisionId,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeMutationOutcome(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // Webhook/event ingestion (append-oriented, server-derived provenance)
  // -------------------------------------------------------------------------

  // POST /api/clients/:clientId/connections/:connectionId/webhook —
  // ingest ONE inbound webhook delivery through the authenticated relay
  // surface. The adapter verifies provider authenticity (after the module's
  // fail-closed secrets-dimension gate); an UNVERIFIED delivery is
  // rejected (422) with NOTHING recorded; a verified one is appended once
  // to the immutable ledger and a derived 'source_fact' observation is
  // appended to /evidence with pinned class/quality/provenance
  // (server-computed — never request-suppliable).
  router.add(
    'POST',
    '/api/clients/:clientId/connections/:connectionId/webhook',
    defineMutationRoute<
      { clientId: string; connectionId: string },
      IntegrationIngestedEventRecord
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      validate: (ctx) =>
        validateObject<{
          eventType: string;
          payload: Record<string, unknown>;
          headers: Record<string, unknown>;
        }>(ctx.request.body, {
          forbiddenKeys: WEBHOOK_INGEST_AUTHORITY_FIELDS,
          fields: {
            eventType: stringField({ minLength: 1, maxLength: 128 }),
            payload: recordField({ maxDepthKeys: 64 }),
            headers: recordField({ maxDepthKeys: 32 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { eventType: string; payload: Record<string, unknown>; headers: Record<string, unknown> };
        return modules.integrations.ingestWebhookEvent(
          {
            connectionId: ctx.params.connectionId,
            eventType: body.eventType,
            payload: body.payload,
            headers: body.headers as Record<string, string>,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('integrations.event.ingested', undefined, {
          event_id: ctx.result.eventId,
          connection_id: ctx.result.connectionId,
          client_id: ctx.params.clientId,
          adapter_key: ctx.result.adapterKey,
          event_type: ctx.result.eventType,
          evidence_ref: ctx.result.evidenceRef,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'integrations.event.ingested',
          targetType: 'integration_event',
          targetId: ctx.result.eventId,
          idempotencyKey: `integrations.event.ingested:${ctx.result.eventId}`,
          details: {
            adapterKey: ctx.result.adapterKey,
            eventType: ctx.result.eventType,
            evidenceRef: ctx.result.evidenceRef,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeEvent(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // Ingested-event reads (the append-only history surface)
  // -------------------------------------------------------------------------

  // GET /api/clients/:clientId/integration-events — the Client's ingested
  // events, newest first (members of the owning agency; foreign Client →
  // uniform 404).
  router.add(
    'GET',
    '/api/clients/:clientId/integration-events',
    defineQueryRoute<{ clientId: string }, readonly IntegrationIngestedEventRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => modules.integrations.listIngestedEventsForClient(ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          events: ctx.result.map(serializeEvent),
        }),
    }),
  );

  // GET /api/integration-events/:eventId — read one ingested event. The
  // event's Client chain resolves canonically inside execute; a member of
  // the OWNING agency reads it, everyone else gets the SAME uniform 404
  // (an event id is never an authorization credential).
  router.add(
    'GET',
    '/api/integration-events/:eventId',
    defineQueryRoute<{ eventId: string }, IntegrationIngestedEventRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const record = await modules.integrations.getIngestedEvent(ctx.params.eventId);
        if (record === null) {
          throw new NotFoundError('integration event', ctx.params.eventId);
        }
        if (ctx.principal.kind === 'service') return;
        await requireClientAccess(modules, ctx.principal, record.clientId);
      },
      execute: async (ctx) => {
        const record = await modules.integrations.getIngestedEvent(ctx.params.eventId);
        if (record === null) {
          throw new NotFoundError('integration event', ctx.params.eventId);
        }
        return record;
      },
      respond: (ctx) => jsonResponse(200, serializeEvent(ctx.result)),
    }),
  );
}
