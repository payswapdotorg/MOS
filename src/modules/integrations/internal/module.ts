/**
 * /integrations module implementation (MKT-023, INT-001 — the provider
 * integration boundary).
 *
 * Thin orchestration over the store + the adapter REGISTRY (data) with the
 * fail-closed chain on every provider-touching action:
 *
 *   canonical /clients ownership resolution (structural port) BEFORE any
 *   read/write → registry data lookup (adapterKey) → capability discovery
 *   (the operation must be declared by a registered capability) → /policies
 *   fail-closed evaluation (network dimension for provider egress, secrets
 *   dimension for credential use — matrix-allowed direct contracts) →
 *   credential MATERIAL resolution through the /credentials
 *   authorized-execution path (in-process only, never persisted) → the
 *   adapter port call → connection bookkeeping (health/rate-limit state).
 *
 * The adapter registry is built ONCE from the injected adapter instances
 * (validated data — buildAdapterRegistry) and never branches on a provider
 * name: provider-specific knowledge lives exclusively behind the
 * IntegrationAdapter port. Webhook ingestion is append-oriented with
 * server-derived provenance; verified events flow to /evidence through the
 * evidence sink structural port (class/quality/provenance pinned — never
 * fabricated).
 *
 * Fail-closed contract (POL-001 posture, consumed from /policies):
 *   - unknown adapter / unknown or foreign Client / unknown credential
 *     reference → uniform NotFoundError (no existence or traversal oracle);
 *   - policy deny/unknown/error → PolicyDeniedError BEFORE any credential
 *     material resolution or provider call;
 *   - non-live connection state (not 'connected') on capability calls →
 *     ConflictError (no provider traffic through dead pipes);
 *   - unresolvable/disabled/scope-mismatched credential at execution time
 *     → ConflictError (fail-closed, never a silent unauthenticated call);
 *   - unverified webhook delivery → InvalidRequestError (nothing recorded,
 *     nothing becomes evidence).
 */

import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PolicyDeniedError,
} from '../../../platform/errors/errors.ts';
import type {
  IntegrationAdapter,
  IntegrationsClientOwnershipSnapshot,
  IntegrationsModuleApi,
  IntegrationsModuleDeps,
  IntegrationConnectionRecord,
  IntegrationProvenance,
  NormalizedMutationResult,
  NormalizedReadResult,
} from '../public.ts';
import { composeIntegrationConnectionOwnerContext, enforcementOutcomePolicy } from './policy-gate.ts';
import {
  assertValidConnectionRegistration,
  assertValidProvenance,
  assertValidWebhookIngestion,
  buildAdapterRegistry,
  classifyIntegrationWriteConflict,
  IntegrationsStore,
  MAX_SUSPEND_REASON_LENGTH,
  toRegisteredAdapterInfo,
} from './store.ts';

/** Bounded execution-parameter surface (the §21 exfiltration guard). */
const MAX_CALL_PARAMETERS_KEYS = 32;

export function createIntegrationsModule(deps: IntegrationsModuleDeps): IntegrationsModuleApi {
  const store = new IntegrationsStore(deps.db, deps.clock, deps.ids);
  const { policies, credentials, clientOwnership, evidenceSink, clock } = deps;

  // The FIRST-PARTY ADAPTER REGISTRY — validated DATA, no provider branches.
  // Construction fails loudly on malformed/duplicate registrations.
  const registry = buildAdapterRegistry(deps.adapters);

  /**
   * Canonical Client ownership resolution from durable state BEFORE any
   * dependent traversal (implementation-contract §2): null → uniform 404
   * (unknown/tombstoned/foreign Client — indistinguishable); disabled →
   * 409 blocks new writes without rewriting history (the evidence/metrics
   * posture; listing stays available).
   */
  async function requireClientForWrite(clientId: string): Promise<IntegrationsClientOwnershipSnapshot> {
    const ownership = await clientOwnership.resolveClientOwnership(clientId);
    if (ownership === null) {
      throw new NotFoundError('client', clientId);
    }
    if (ownership.client.status !== 'active') {
      throw new ConflictError(
        `client ${clientId} is ${ownership.client.status}; new integration writes are blocked`,
      );
    }
    return ownership;
  }

  /** Registry data lookup: an unknown adapter key is a uniform 404. */
  function requireAdapter(adapterKey: string): IntegrationAdapter {
    const adapter = registry.get(adapterKey);
    if (adapter === undefined) {
      throw new NotFoundError('integration adapter', adapterKey);
    }
    return adapter;
  }

  /**
   * The connection's adapter — a connection may outlive a deployment's
   * adapter set; an unregistered adapter key makes the pipe unusable
   * (fail-closed 409, never a silent skip).
   */
  function requireConnectionAdapter(connection: IntegrationConnectionRecord): IntegrationAdapter {
    const adapter = registry.get(connection.adapterKey);
    if (adapter === undefined) {
      throw new ConflictError(
        `connection ${connection.connectionId} references adapter '${connection.adapterKey}' which is not registered in this deployment`,
      );
    }
    return adapter;
  }

  /**
   * The live-pipe gate: capability calls (read/mutation/webhook) flow only
   * through a CONNECTED connection (fail-closed on every other state).
   */
  function requireConnected(connection: IntegrationConnectionRecord): void {
    if (connection.status !== 'connected') {
      throw new ConflictError(
        `connection ${connection.connectionId} is '${connection.status}'; capability calls require a connected pipe`,
      );
    }
  }

  /**
   * The capability-discovery gate: the requested operation must be declared
   * by a registered capability of the connection's adapter (data lookup —
   * no provider branches).
   */
  function requireDeclaredOperation(
    adapter: IntegrationAdapter,
    kind: 'read' | 'mutation',
    operation: string,
  ): void {
    const declared = adapter.capabilities.some(
      (capability) => capability.kind === kind && (capability.operations as readonly string[]).includes(operation),
    );
    if (!declared) {
      throw new InvalidRequestError('Unknown integration operation', [
        `operation: '${operation}' is not declared by any ${kind} capability of adapter '${adapter.descriptor.adapterKey}'`,
      ]);
    }
  }

  /** The §21 exfiltration guard on execution parameters (outbound data). */
  function assertValidCallParameters(parameters: Readonly<Record<string, unknown>>): void {
    const problems: string[] = [];
    if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
      problems.push('parameters: must be a JSON object');
    } else {
      const keys = Object.keys(parameters);
      if (keys.length > MAX_CALL_PARAMETERS_KEYS) {
        problems.push(`parameters: at most ${MAX_CALL_PARAMETERS_KEYS} top-level keys`);
      }
      if (parametersContainsMaterialShapedKey(parameters)) {
        problems.push('parameters: material-shaped keys are forbidden at every level (§21)');
      }
    }
    if (problems.length > 0) {
      throw new InvalidRequestError('Invalid integration operation parameters', problems);
    }
  }

  function parametersContainsMaterialShapedKey(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) {
      return value.some((entry) => parametersContainsMaterialShapedKey(entry));
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (['secret', 'secretMaterial', 'material', 'password', 'token', 'apiKey', 'api_key', 'accessKey', 'secretHandle'].includes(key)) {
        return true;
      }
      if (parametersContainsMaterialShapedKey(entry)) return true;
    }
    return false;
  }

  /**
   * Credential MATERIAL resolution for an allowed action: the sanctioned
   * authorized-execution context (implementation-contract §21) — scope
   * matches the connection's owning chain exactly; the resolved material
   * exists ONLY in-process for the adapter call.
   */
  async function resolveCallMaterial(connection: IntegrationConnectionRecord): Promise<Uint8Array> {
    const resolved = await credentials.resolveCredentialMaterial({
      credentialId: connection.credentialReferenceId,
      scope: {
        kind: 'authorized-execution',
        agencyId: connection.agencyId,
        clientId: connection.clientId,
      },
    });
    if (resolved === null) {
      throw new ConflictError(
        `credential reference ${connection.credentialReferenceId} of connection ${connection.connectionId} no longer resolves in its scope (disabled, tombstoned or scope-mismatched — fail-closed)`,
      );
    }
    return resolved.material;
  }

  /** The adapter call context (material in-process ONLY). */
  function callContext(
    connection: IntegrationConnectionRecord,
    material: Uint8Array,
  ) {
    return {
      connectionId: connection.connectionId,
      providerConfig: connection.providerConfig,
      credentialMaterial: material,
    };
  }

  return {
    listRegisteredAdapters() {
      return [...registry.values()]
        .map(toRegisteredAdapterInfo)
        .sort((a, b) => a.descriptor.adapterKey.localeCompare(b.descriptor.adapterKey));
    },

    async registerConnection(input, provenance) {
      assertValidProvenance(provenance);
      assertValidConnectionRegistration(input);
      const ownership = await requireClientForWrite(input.clientId);
      const adapter = requireAdapter(input.adapterKey);

      // Credential REFERENCE validation through the /credentials public
      // contract (matrix dependency): LIVE + scope-compatible with the
      // Client. A foreign reference is a uniform 404 (no oracle).
      const reference = await credentials.getCredentialReference(input.credentialReferenceId);
      if (reference === null) {
        throw new NotFoundError('credential reference', input.credentialReferenceId);
      }
      if (reference.status !== 'active') {
        throw new ConflictError(
          `credential reference ${input.credentialReferenceId} is ${reference.status}; new connections require an active reference`,
        );
      }
      if (reference.agencyId !== ownership.client.agencyId) {
        throw new NotFoundError('credential reference', input.credentialReferenceId);
      }
      if (reference.clientId !== null && reference.clientId !== input.clientId) {
        throw new NotFoundError('credential reference', input.credentialReferenceId);
      }

      try {
        return await store.insertConnection({
          clientId: input.clientId,
          agencyId: ownership.client.agencyId,
          adapterKey: adapter.descriptor.adapterKey,
          providerLabel: adapter.descriptor.providerLabel,
          credentialReferenceId: input.credentialReferenceId,
          providerConfig: input.providerConfig,
          createdBy: null,
        });
      } catch (error) {
        if (classifyIntegrationWriteConflict(error) !== null) {
          throw new ConflictError(
            'a connection for this client, adapter and credential reference already exists',
          );
        }
        throw error;
      }
    },

    async getConnection(connectionId) {
      return store.getConnection(connectionId);
    },

    async resolveConnectionOwnership(connectionId) {
      const connection = await store.getConnection(connectionId);
      if (connection === null) return null;
      const ownership = await clientOwnership.resolveClientOwnership(connection.clientId);
      if (ownership === null) return null;
      if (ownership.client.agencyId !== connection.agencyId) return null;
      return composeIntegrationConnectionOwnerContext(connection, ownership, clock.nowIso());
    },

    async listConnectionsForClient(clientId) {
      const ownership = await clientOwnership.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listConnectionsForClient(clientId);
    },

    async connectConnection(input, provenance) {
      assertValidProvenance(provenance);
      const ownership = await this.resolveConnectionOwnership(input.connectionId);
      if (ownership === null) {
        throw new NotFoundError('integration connection', input.connectionId);
      }
      const connection = ownership.connection;
      const adapter = requireConnectionAdapter(connection);

      // FAIL-CLOSED policy gate BEFORE any credential resolution or
      // provider call: network egress (the probe) must be explicitly
      // allowed for this Client scope.
      await requirePolicyAllow(
        {
          dimension: 'network',
          operation: 'integration.connect',
          resource: connection.adapterKey,
          attributes: { provider: connection.adapterKey },
        },
        { agencyId: connection.agencyId, clientId: connection.clientId },
        provenance,
      );

      const material = await resolveCallMaterial(connection);
      let probe: Awaited<ReturnType<IntegrationAdapter['probeConnection']>>;
      try {
        probe = await adapter.probeConnection(callContext(connection, material));
      } catch (error) {
        // A throwing adapter is an unreachable pipe (fail-closed posture):
        // the transition records the failure, never fabricates health.
        probe = {
          reachable: false,
          healthy: false,
          message: `adapter probe threw: ${error instanceof Error ? error.message : String(error)}`,
          rateLimit: null,
        };
      }

      return store.transitionConnection(
        connection.connectionId,
        input.expectedVersion,
        {
          status: probe.reachable ? 'connected' : 'error',
          health: probe.reachable ? (probe.healthy ? 'healthy' : 'degraded') : 'unreachable',
          rateLimit: probe.rateLimit,
          lastError: probe.reachable ? null : (probe.message ?? 'provider unreachable'),
        },
      );
    },

    async suspendConnection(input, provenance) {
      assertValidProvenance(provenance);
      if (input.reason !== null && (typeof input.reason !== 'string' || input.reason.length > MAX_SUSPEND_REASON_LENGTH)) {
        throw new InvalidRequestError('Invalid suspension reason', [
          `reason: must be at most ${MAX_SUSPEND_REASON_LENGTH} characters`,
        ]);
      }
      const ownership = await this.resolveConnectionOwnership(input.connectionId);
      if (ownership === null) {
        throw new NotFoundError('integration connection', input.connectionId);
      }
      // Pure bookkeeping: no provider call, no policy gate, no material.
      return store.transitionConnection(input.connectionId, input.expectedVersion, {
        status: 'suspended',
        health: ownership.connection.health,
        rateLimit: ownership.connection.rateLimit,
        lastError: ownership.connection.lastError,
      });
    },

    async executeRead(input, provenance) {
      assertValidProvenance(provenance);
      assertValidCallParameters(input.parameters);
      const ownership = await this.resolveConnectionOwnership(input.connectionId);
      if (ownership === null) {
        throw new NotFoundError('integration connection', input.connectionId);
      }
      const connection = ownership.connection;
      requireConnected(connection);
      const adapter = requireConnectionAdapter(connection);
      requireDeclaredOperation(adapter, 'read', input.operation);

      // FAIL-CLOSED gates: network egress for the read, then credential
      // use for the call. Deny/unknown → PolicyDeniedError BEFORE any
      // material resolution or provider traffic.
      const networkDecisionId = await requirePolicyAllow(
        {
          dimension: 'network',
          operation: 'integration.read',
          resource: connection.adapterKey,
          attributes: { provider: connection.adapterKey },
        },
        { agencyId: connection.agencyId, clientId: connection.clientId },
        provenance,
      );
      await requirePolicyAllow(
        {
          dimension: 'secrets',
          operation: 'integration.credential',
          resource: connection.credentialReferenceId,
          attributes: { provider: connection.adapterKey },
        },
        { agencyId: connection.agencyId, clientId: connection.clientId },
        provenance,
      );

      const material = await resolveCallMaterial(connection);
      let result: NormalizedReadResult;
      try {
        result = await adapter.read(callContext(connection, material), {
          operation: input.operation,
          parameters: input.parameters,
        });
      } catch (error) {
        result = {
          ok: false,
          records: [],
          error: `adapter read threw: ${error instanceof Error ? error.message : String(error)}`,
          rateLimit: null,
        };
      }

      // Bookkeeping: the observed health/rate-limit state of the pipe.
      const updated = await store.applyCallBookkeeping(connection.connectionId, {
        status: result.ok ? 'connected' : 'error',
        health: result.ok ? 'healthy' : 'unreachable',
        rateLimit: result.rateLimit,
        lastError: result.ok ? null : (result.error ?? 'provider call failed'),
      });

      return {
        connectionId: connection.connectionId,
        adapterKey: connection.adapterKey,
        operation: input.operation,
        ok: result.ok,
        records: result.records,
        error: result.error,
        rateLimit: result.rateLimit,
        policyDecisionId: networkDecisionId,
        connection: updated,
      };
    },

    async executeMutation(input, provenance) {
      assertValidProvenance(provenance);
      assertValidCallParameters(input.parameters);
      const ownership = await this.resolveConnectionOwnership(input.connectionId);
      if (ownership === null) {
        throw new NotFoundError('integration connection', input.connectionId);
      }
      const connection = ownership.connection;
      requireConnected(connection);
      const adapter = requireConnectionAdapter(connection);
      requireDeclaredOperation(adapter, 'mutation', input.operation);

      const networkDecisionId = await requirePolicyAllow(
        {
          dimension: 'network',
          operation: 'integration.mutate',
          resource: connection.adapterKey,
          attributes: { provider: connection.adapterKey },
        },
        { agencyId: connection.agencyId, clientId: connection.clientId },
        provenance,
      );
      await requirePolicyAllow(
        {
          dimension: 'secrets',
          operation: 'integration.credential',
          resource: connection.credentialReferenceId,
          attributes: { provider: connection.adapterKey },
        },
        { agencyId: connection.agencyId, clientId: connection.clientId },
        provenance,
      );

      const material = await resolveCallMaterial(connection);
      let result: NormalizedMutationResult;
      try {
        result = await adapter.mutate(callContext(connection, material), {
          operation: input.operation,
          parameters: input.parameters,
        });
      } catch (error) {
        result = {
          ok: false,
          providerRecordId: null,
          data: null,
          error: `adapter mutation threw: ${error instanceof Error ? error.message : String(error)}`,
          rateLimit: null,
        };
      }

      const updated = await store.applyCallBookkeeping(connection.connectionId, {
        status: result.ok ? 'connected' : 'error',
        health: result.ok ? 'healthy' : 'unreachable',
        rateLimit: result.rateLimit,
        lastError: result.ok ? null : (result.error ?? 'provider call failed'),
      });

      return {
        connectionId: connection.connectionId,
        adapterKey: connection.adapterKey,
        operation: input.operation,
        ok: result.ok,
        providerRecordId: result.providerRecordId,
        data: result.data,
        error: result.error,
        rateLimit: result.rateLimit,
        policyDecisionId: networkDecisionId,
        connection: updated,
      };
    },

    async ingestWebhookEvent(input, provenance) {
      assertValidProvenance(provenance);
      assertValidWebhookIngestion(input);
      const ownership = await this.resolveConnectionOwnership(input.connectionId);
      if (ownership === null) {
        throw new NotFoundError('integration connection', input.connectionId);
      }
      const connection = ownership.connection;
      requireConnected(connection);
      const adapter = requireConnectionAdapter(connection);
      if (!adapter.capabilities.some((capability) => capability.kind === 'webhook')) {
        throw new InvalidRequestError('Adapter declares no webhook capability', [
          `adapter '${connection.adapterKey}' declares no webhook capability — deliveries cannot be verified`,
        ]);
      }

      // FAIL-CLOSED gate: webhook verification uses the credential
      // (secrets dimension, operation 'integration.webhook').
      await requirePolicyAllow(
        {
          dimension: 'secrets',
          operation: 'integration.webhook',
          resource: connection.credentialReferenceId,
          attributes: { provider: connection.adapterKey },
        },
        { agencyId: connection.agencyId, clientId: connection.clientId },
        provenance,
      );

      const material = await resolveCallMaterial(connection);
      let verification: Awaited<ReturnType<IntegrationAdapter['verifyWebhook']>>;
      try {
        verification = await adapter.verifyWebhook(callContext(connection, material), {
          eventType: input.eventType,
          payload: input.payload,
          headers: input.headers,
        });
      } catch (error) {
        verification = {
          verified: false,
          reason: `adapter verification threw: ${error instanceof Error ? error.message : String(error)}`,
          normalizedEventType: null,
        };
      }
      if (!verification.verified) {
        // Nothing is recorded and nothing becomes evidence (fail-closed:
        // an unverified delivery is rejected outright).
        throw new InvalidRequestError('Webhook delivery failed provider verification', [
          `verification: ${verification.reason ?? 'the adapter rejected the delivery'}`,
        ]);
      }

      const eventId = deps.ids.newId();
      const eventType = verification.normalizedEventType ?? input.eventType;

      // The derived /evidence observation (through /evidence's own public
      // contract — the structural sink port): class/quality/provenance are
      // PINNED honest values, never caller-suppliable and never fabricated
      // by this module. The event identity is the source reference.
      const evidence = await evidenceSink.appendEvidence(
        {
          clientId: connection.clientId,
          workspaceId: null,
          class: 'source_fact',
          source: {
            system: `integration:${connection.adapterKey}`,
            ref: eventId,
          },
          observedAt: clock.nowIso(),
          content: {
            eventType,
            provider: connection.adapterKey,
            payload: input.payload,
          },
          contentRef: null,
          quality: 'C',
          confidence: null,
          supersedesEvidenceId: null,
        },
        {
          actor: provenance.actor,
          recordedVia: `integration:${connection.adapterKey}`,
          correlationId: provenance.correlationId,
          causationId: provenance.causationId,
        },
      );

      // The append-only ingestion ledger row (evidenceRef already resolved).
      return store.insertEvent(
        {
          eventId,
          connectionId: connection.connectionId,
          clientId: connection.clientId,
          adapterKey: connection.adapterKey,
          eventType,
          payload: input.payload,
          evidenceRef: evidence.evidenceId,
        },
        provenance,
      );
    },

    async getIngestedEvent(eventId) {
      return store.getEvent(eventId);
    },

    async listIngestedEventsForClient(clientId) {
      const ownership = await clientOwnership.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listEventsForClient(clientId);
    },
  };

  /**
   * FAIL-CLOSED policy gate: delegates to the /policies public contract
   * (matrix dependency) and proceeds ONLY on an explicit allow. Deny,
   * unknown, ambiguous scope and evaluation errors all surface as
   * PolicyDeniedError (the policies engine already recorded the decision
   * with its own provenance) — the action never happens.
   */
  async function requirePolicyAllow(
    action: {
      readonly dimension: 'network' | 'secrets';
      readonly operation: string;
      readonly resource: string | null;
      readonly attributes: Readonly<Record<string, string>>;
    },
    scope: {
      readonly agencyId: string;
      readonly clientId: string | null;
    },
    provenance: IntegrationProvenance,
  ): Promise<string> {
    const decision = await policies.evaluateAction(
      {
        action: {
          dimension: action.dimension,
          operation: action.operation,
          resource: action.resource,
          attributes: action.attributes as Record<string, string>,
        },
        scope: { agencyId: scope.agencyId, clientId: scope.clientId },
      },
      {
        actor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
      },
    );
    if (enforcementOutcomePolicy(decision) !== 'allow') {
      throw new PolicyDeniedError(
        `integration action denied by policy (dimension '${action.dimension}', operation '${action.operation}'; decision ${decision.decisionId}, reason '${decision.reasonCode}')`,
      );
    }
    return decision.decisionId;
  }
}
