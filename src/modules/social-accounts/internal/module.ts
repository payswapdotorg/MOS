/**
 * /social-accounts module implementation (MKT-055 — the Social Account
 * and OAuth Connection Model).
 *
 * Thin orchestration over the store + the flow registry (data) with the
 * fail-closed chain on every provider-touching flow step:
 *
 *   canonical integration-connection ownership resolution (through the
 *   /integrations public contract — the connection owns the client chain)
 *   BEFORE any read/write → authorized-connection gate (status
 *   'connected' — an authorized Integration) → flow-registry data lookup
 *   (the platform identity is the adapter key; a platform with no
 *   registered flow is refused fail-closed) → /policies fail-closed
 *   evaluation (network dimension for provider egress; secrets dimension
 *   for credential use) → credential MATERIAL resolution through the
 *   /credentials authorized-execution path (in-process only, the
 *   integrations resolveCallMaterial precedent) → the flow port call →
 *   the append-only recording.
 *
 * The binding semantics (MKT-055 AC-4): one connection binds one platform
 * identity; re-connecting the same external account under the same
 * integration is idempotent (the existing binding is reused, the current
 * grant is superseded, its vault reference disabled — no duplicate active
 * binding); conflicting bindings are rejected fail-closed (the
 * migration-046 partial unique fences back the race).
 *
 * The death semantics (MKT-055 AC-5): disconnect and revocation — both
 * operator-initiated and externally-signalled — leave the connection
 * UNUSABLE: the vault references are disabled, the live grants are
 * revoked, the binding moves to its terminal state and every event is
 * appended; every authorization-bearing read refuses from then on (no
 * zombie grants).
 *
 * Fail-closed contract (POL-001 posture, consumed from /policies):
 *   - unknown/foreign integration connection or client / unknown state
 *     token / unknown grant or account / unknown workspace → uniform
 *     NotFoundError (no existence or traversal oracle);
 *   - a non-connected integration pipe, a platform with no registered
 *     flow, a consumed round, a conflicting binding, a disconnected or
 *     revoked account, a non-refreshable grant, a dangling credential
 *     handle → ConflictError (fail-closed, zero rows);
 *   - policy deny/unknown → PolicyDeniedError BEFORE any credential
 *     material resolution or provider call.
 */

import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
} from '../../../platform/errors/errors.ts';
import type { IntegrationsConnectionOwnerContext } from '../../integrations/public.ts';
import type {
  SocialAccountFlowCallContext,
  SocialAccountFlowExchangeOutcome,
  SocialAccountProvenance,
  SocialAccountsModuleApi,
  SocialAccountsModuleDeps,
  SocialGrantRecord,
} from '../public.ts';
import { isGrantRefreshable, SOCIAL_ACCOUNT_TOKEN_CREDENTIAL_KIND } from '../public.ts';
import { enforcementOutcome } from '../../policies/public.ts';
import {
  assertValidCapabilityTagList,
  assertValidExpiresAt,
  assertValidFlowIdentity,
  assertValidGrantedScopeList,
  assertValidProvenance,
  assertValidReason,
  assertValidRequestedScopes,
  assertValidTokenSecretHandle,
  buildFlowRegistry,
  composeGrantCompletedEvent,
  composeGrantStartEvent,
  composeSocialAccountEvent,
  composeSocialAccountOwnerContext,
} from './grant-validation.ts';
import { SocialAccountsStore } from './store.ts';

/** The bounded signalled-via label of an external revocation signal. */
const SIGNALLED_VIA_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export function createSocialAccountsModule(
  deps: SocialAccountsModuleDeps,
): SocialAccountsModuleApi {
  const store = new SocialAccountsStore(deps.db, deps.clock, deps.ids);
  const { integrations, credentials, policies, workspaceOwnership, clock, db } = deps;

  // THE FLOW REGISTRY — validated DATA, no provider branches. Construction
  // fails loudly on malformed/duplicate registrations (the MKT-023
  // precedent). EMPTY in the production composition until MKT-056+ wires
  // real flows; the integration tests supply the local provider double.
  const flowRegistry = buildFlowRegistry(deps.flows);

  /**
   * The canonical integration-connection ownership resolution (through
   * the /integrations public contract — the connection owns the client
   * chain; this module never re-derives tenants from caller input):
   * null → uniform 404 (unknown/tombstoned/foreign — indistinguishable).
   */
  async function requireConnectionOwnership(
    integrationConnectionId: string,
    clientId: string,
  ): Promise<IntegrationsConnectionOwnerContext> {
    const ownership = await integrations.resolveConnectionOwnership(integrationConnectionId);
    if (ownership === null || ownership.connection.clientId !== clientId) {
      throw new NotFoundError('integration connection', integrationConnectionId);
    }
    return ownership;
  }

  /**
   * The AUTHORIZED-INTEGRATION gate: a social account attaches through an
   * EXISTING authorized Integration — the connection must be in the
   * `connected` state (a registered/suspended/error pipe is a fail-closed
   * 409, the requireConnected precedent).
   */
  function requireConnectedIntegration(ownership: IntegrationsConnectionOwnerContext): void {
    if (ownership.connection.status !== 'connected') {
      throw new ConflictError(
        `integration connection ${ownership.connection.connectionId} is '${ownership.connection.status}'; social accounts attach only through an authorized (connected) integration`,
      );
    }
  }

  /** The flow-registry data lookup: a platform with no registered flow is refused. */
  function requireFlow(platformId: string) {
    const flow = flowRegistry.get(platformId);
    if (flow === undefined) {
      throw new ConflictError(
        `no OAuth flow implementation is registered for platform '${platformId}' in this deployment (the adapter contract arrives with MKT-056+)`,
      );
    }
    return flow;
  }

  /** The provider-neutral flow call context (identity + non-secret config only). */
  function flowContext(
    ownership: IntegrationsConnectionOwnerContext,
    workspaceId: string | null,
  ): SocialAccountFlowCallContext {
    return {
      connectionId: ownership.connection.connectionId,
      agencyId: ownership.connection.agencyId,
      clientId: ownership.connection.clientId,
      workspaceId,
      platformId: ownership.connection.adapterKey,
      providerConfig: ownership.connection.providerConfig,
    };
  }

  /**
   * Validates the exchange outcome of a flow implementation (pure guards)
   * — the verbatim scope list, the capability tags, the identity facts,
   * the token handle shape and the expiry.
   */
  function validateExchangeOutcome(outcome: SocialAccountFlowExchangeOutcome): void {
    assertValidFlowIdentity(outcome.identity);
    assertValidGrantedScopeList(outcome.grantedScopes);
    assertValidCapabilityTagList(outcome.capabilityTags);
    assertValidTokenSecretHandle(outcome.tokenSecretHandle);
    assertValidExpiresAt(outcome.expiresAt);
  }

  /**
   * Creates the grant's OWN least-privilege credential REFERENCE through
   * the /credentials public contract (lock rule 28: the social-account
   * grant confers no product/source/store access — its reference is its
   * own kind, never shared). FAILS CLOSED on a handle that does not
   * resolve in the secret backend (the dangling-reference rejection — no
   * orphan references).
   */
  async function createTokenReference(input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly platformId: string;
    readonly grantId: string;
    readonly tokenSecretHandle: string;
  }): Promise<string> {
    const reference = await credentials.createCredentialReference({
      agencyId: input.agencyId,
      clientId: input.clientId,
      kind: SOCIAL_ACCOUNT_TOKEN_CREDENTIAL_KIND,
      // The vault label: the platform prefix (bounded) + the unique grant
      // id — the credential-label grammar (letters/digits/spaces/dots/
      // slashes/underscores ONLY: the grant id's dashes are stripped; the
      // id itself carries the uniqueness).
      label: `sa/${input.platformId.slice(0, 20)}/${input.grantId.replace(/-/g, '')}`.slice(0, 100),
      secretHandle: input.tokenSecretHandle,
      actorId: null,
    });
    return reference.credentialId;
  }

  /**
   * Disables a replaced/dead grant's vault reference through the
   * /credentials public contract (no zombie grants). Idempotent
   * (already-disabled/deleted references are skipped) and ordered BEFORE
   * the durable state transition so an unexpected failure aborts the
   * whole operation with nothing recorded; if the state transition were
   * to fail after a successful disablement, every downstream use still
   * fails closed (the authorized-execution resolution of a disabled
   * reference returns null) — the disable-first ordering can never
   * zombify INTO use.
   */
  async function disableTokenReference(credentialReferenceId: string): Promise<void> {
    const reference = await credentials.getCredentialReference(credentialReferenceId);
    if (reference === null || reference.status !== 'active') return;
    try {
      await credentials.setCredentialStatus({
        credentialId: credentialReferenceId,
        status: 'disabled',
        expectedVersion: reference.version,
      });
    } catch {
      // A version race (concurrent disablement) still converges: re-read
      // and confirm; anything else surfaces as the fail-closed conflict.
      const reread = await credentials.getCredentialReference(credentialReferenceId);
      if (reread === null || reread.status === 'active') {
        throw new ConflictError(
          `credential reference ${credentialReferenceId} could not be disabled — fail-closed`,
        );
      }
    }
  }

  /**
   * Credential MATERIAL resolution for an allowed flow step: the
   * sanctioned authorized-execution context (§21) — scope matches the
   * connection's owning chain exactly; the resolved material exists ONLY
   * in-process for the flow call.
   */
  async function resolveTokenMaterial(
    ownership: IntegrationsConnectionOwnerContext,
    credentialReferenceId: string,
  ): Promise<Uint8Array> {
    const resolved = await credentials.resolveCredentialMaterial({
      credentialId: credentialReferenceId,
      scope: {
        kind: 'authorized-execution',
        agencyId: ownership.connection.agencyId,
        clientId: ownership.connection.clientId,
      },
    });
    if (resolved === null) {
      throw new ConflictError(
        `credential reference ${credentialReferenceId} of the social-account grant no longer resolves in its scope (disabled, tombstoned or scope-mismatched — fail-closed)`,
      );
    }
    return resolved.material;
  }

  /** FAIL-CLOSED policy gate (the integrations requirePolicyAllow pattern). */
  async function requirePolicyAllow(
    action: {
      readonly dimension: 'network' | 'secrets';
      readonly operation: string;
      readonly resource: string | null;
      readonly attributes: Readonly<Record<string, string>>;
    },
    scope: {
      readonly agencyId: string;
      readonly clientId: string;
    },
    provenance: SocialAccountProvenance,
  ): Promise<void> {
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
    if (enforcementOutcome(decision) !== 'allow') {
      throw new PolicyDeniedError(
        `social-account action denied by policy (dimension '${action.dimension}', operation '${action.operation}'; decision ${decision.decisionId}, reason '${decision.reasonCode}')`,
      );
    }
  }

  /** The live (potentially still-active) grants of an account: authorized + expired. */
  async function liveGrantsOf(socialAccountId: string): Promise<readonly SocialGrantRecord[]> {
    return (await store.listGrantsForAccount(socialAccountId)).filter(
      (grant) => grant.grantState === 'authorized' || grant.grantState === 'expired',
    );
  }

  return {
    async startAuthorization(input, provenance) {
      assertValidProvenance(provenance);
      assertValidRequestedScopes(input.requestedScopes);

      const ownership = await requireConnectionOwnership(
        input.integrationConnectionId,
        input.clientId,
      );
      requireConnectedIntegration(ownership);

      // The OPTIONAL workspace narrowing: canonical /workspaces ownership
      // resolution through the structural port (unknown/foreign → uniform
      // 404; a workspace of ANOTHER client is a 404, never an oracle).
      if (input.workspaceId !== null) {
        const workspace = await workspaceOwnership.resolveWorkspaceOwnership(input.workspaceId);
        if (workspace === null || workspace.client.clientId !== input.clientId) {
          throw new NotFoundError('workspace', input.workspaceId);
        }
      }

      // The REAUTHORIZE pre-binding: the round is pinned to an existing
      // account of THIS connection (a foreign/dead/mismatched account is
      // refused fail-closed).
      if (input.expectedAccountId !== null) {
        const expected = await store.getAccount(input.expectedAccountId);
        if (expected === null || expected.clientId !== input.clientId) {
          throw new NotFoundError('social account', input.expectedAccountId);
        }
        if (expected.integrationConnectionId !== input.integrationConnectionId) {
          throw new ConflictError(
            `social account ${input.expectedAccountId} is bound to another integration connection — reauthorization runs through the SAME integration`,
          );
        }
        if (expected.status !== 'connected') {
          throw new ConflictError(
            `social account ${input.expectedAccountId} is '${expected.status}'; a dead binding cannot be re-activated in place — start a fresh authorization on the connection`,
          );
        }
      }

      const flow = requireFlow(ownership.connection.adapterKey);
      const stateToken = deps.ids.newId();
      const url = await flow.buildAuthorizeUrl(
        flowContext(ownership, input.workspaceId),
        { state: stateToken, requestedScopes: input.requestedScopes },
      );

      const grant = await store.insertPendingGrant(
        db,
        {
          integrationConnectionId: ownership.connection.connectionId,
          agencyId: ownership.connection.agencyId,
          clientId: ownership.connection.clientId,
          workspaceId: input.workspaceId,
          socialAccountId: input.expectedAccountId,
          platformId: ownership.connection.adapterKey,
          stateToken,
          requestedScopes: input.requestedScopes,
        },
        provenance,
      );
      await store.appendEvent(
        db,
        composeGrantStartEvent(
          { socialAccountId: input.expectedAccountId, grantId: grant.grantId },
          provenance,
        ),
      );
      return { grant, authorizeUrl: url.authorizeUrl };
    },

    async completeAuthorization(input, provenance) {
      assertValidProvenance(provenance);

      // The round correlates by the OPAQUE state token, scoped to the
      // caller's client (a foreign round is the uniform 404 — no oracle).
      const round = await store.getGrantByStateToken(input.state);
      if (round === null || round.clientId !== input.clientId) {
        throw new NotFoundError('authorization round', input.state);
      }
      if (round.grantState !== 'pending') {
        throw new ConflictError(
          `authorization round ${round.grantId} is '${round.grantState}' — a consumed or dead round can never be completed again`,
        );
      }

      // The pipe must still be an authorized integration at callback time.
      const ownership = await requireConnectionOwnership(
        round.integrationConnectionId,
        input.clientId,
      );
      requireConnectedIntegration(ownership);
      const flow = requireFlow(ownership.connection.adapterKey);

      // FAIL-CLOSED policy gate BEFORE the provider egress (the code
      // exchange is a provider call).
      await requirePolicyAllow(
        {
          dimension: 'network',
          operation: 'social-account.complete',
          resource: ownership.connection.adapterKey,
          attributes: { platform: ownership.connection.adapterKey },
        },
        {
          agencyId: ownership.connection.agencyId,
          clientId: ownership.connection.clientId,
        },
        provenance,
      );

      const outcome = await flow.exchangeAuthorizationCode(
        flowContext(ownership, null),
        { code: input.code, state: input.state },
      );
      validateExchangeOutcome(outcome);

      // THE BINDING TARGET (AC-4): the account this round completes into —
      // the REAUTHORIZE pre-binding, the connection's CURRENT connected
      // binding (the idempotent-reconnect convergence) or null (a FRESH
      // binding, inserted inside the transaction below). The identity
      // checks run BEFORE the vault reference is created (a rejected
      // conflicting binding must leave NO orphan reference behind).
      const prebound = round.socialAccountId;
      const preboundAccount =
        prebound !== null ? await store.getAccount(prebound) : null;
      if (prebound !== null) {
        if (preboundAccount === null) {
          throw new NotFoundError('social account', prebound);
        }
        if (preboundAccount.status !== 'connected') {
          throw new ConflictError(
            `social account ${preboundAccount.socialAccountId} is '${preboundAccount.status}'; the reauthorize round cannot complete on a dead binding`,
          );
        }
        if (preboundAccount.externalAccountId !== outcome.identity.externalAccountId) {
          throw new ConflictError(
            `the authorization round returned external account '${outcome.identity.externalAccountId}' but the connection's binding is '${preboundAccount.externalAccountId}' — one connection binds one platform identity (fail-closed)`,
          );
        }
      }
      const existingBinding = await store.getConnectedAccountForConnection(
        ownership.connection.connectionId,
      );
      if (
        prebound === null
        && existingBinding !== null
        && existingBinding.externalAccountId !== outcome.identity.externalAccountId
      ) {
        throw new ConflictError(
          `the integration connection already binds external account '${existingBinding.externalAccountId}' — one connection binds one platform identity (fail-closed)`,
        );
      }
      const targetAccount = preboundAccount ?? existingBinding;

      // The supersede target: the account's CURRENT grant (authorized, or
      // EXPIRED — the reauthorize recovery of an expired authorization).
      // Its vault reference dies FIRST (the disable-first ordering).
      const currentForSupersede = targetAccount !== null
        ? (await store.listGrantsForAccount(targetAccount.socialAccountId)).find(
            (grant) => grant.grantState === 'authorized' || grant.grantState === 'expired',
          ) ?? null
        : null;
      if (
        currentForSupersede !== null
        && currentForSupersede.credentialReferenceId !== null
        && currentForSupersede.grantId !== round.grantId
      ) {
        await disableTokenReference(currentForSupersede.credentialReferenceId);
      }

      // The grant's OWN least-privilege vault reference (created BEFORE
      // any durable state changes — a dangling handle aborts with zero
      // rows and the round stays pending).
      const credentialReferenceId = await createTokenReference({
        agencyId: ownership.connection.agencyId,
        clientId: ownership.connection.clientId,
        platformId: ownership.connection.adapterKey,
        grantId: round.grantId,
        tokenSecretHandle: outcome.tokenSecretHandle,
      });

      // THE BINDING + THE FILL, inside ONE transaction with the round
      // LOCKED first (concurrent completions of the same round serialize;
      // the loser re-reads a consumed round and refuses before touching
      // anything). The superseded grant's vault reference is disabled
      // BEFORE the transaction (the disable-first ordering — an abort
      // leaves no zombie INTO use, and the round stays retryable).
      // The superseded grant's vault reference dies BEFORE the transaction
      // (the disable-first ordering — an abort leaves no zombie INTO use,
      // and the round stays retryable).
      if (targetAccount !== null) {
        const currentGrant = await store.getCurrentAuthorizedGrant(targetAccount.socialAccountId);
        if (currentGrant !== null && currentGrant.credentialReferenceId !== null) {
          await disableTokenReference(currentGrant.credentialReferenceId);
        }
      }

      const { account, grant } = await db.transaction(async (tx) => {
        const locked = await store.lockGrant(tx, round.grantId);
        if (locked === null || locked.grantState !== 'pending') {
          throw new ConflictError(
            `authorization round ${round.grantId} was consumed concurrently — the completion refuses (fail-closed)`,
          );
        }
        const account = targetAccount !== null
          ? targetAccount
          : await store.insertAccount(
              tx,
              {
                integrationConnectionId: ownership.connection.connectionId,
                agencyId: ownership.connection.agencyId,
                clientId: ownership.connection.clientId,
                workspaceId: round.workspaceId,
                platformId: ownership.connection.adapterKey,
                externalAccountId: outcome.identity.externalAccountId,
                displayIdentity: outcome.identity.displayIdentity,
                verifiedAt: outcome.identity.verifiedAt,
              },
              provenance,
            );
        // The idempotent-reconnect / reauthorize supersession: the
        // target account's current grant (authorized or expired) is
        // superseded by THIS round inside the same transaction (the
        // single-active-authorization fence requires the transition
        // BEFORE the fill).
        if (targetAccount !== null) {
          const current =
            (await store.listGrantsForAccount(account.socialAccountId)).find(
              (grant) => grant.grantState === 'authorized' || grant.grantState === 'expired',
            ) ?? null;
          if (current !== null) {
            await store.transitionGrantState(tx, {
              grantId: current.grantId,
              grantState: 'superseded',
              successorGrantId: locked.grantId,
              expectedVersion: current.version,
            });
            await store.appendEvent(
              tx,
              composeSocialAccountEvent(
                {
                  socialAccountId: account.socialAccountId,
                  grantId: current.grantId,
                  eventType: 'grant_superseded',
                  initiatedBy: 'operator',
                  reason: null,
                  providerRevokeOutcome: null,
                },
                provenance,
              ),
            );
          }
        }
        const grant = await store.completeGrant(
          tx,
          {
            grantId: locked.grantId,
            socialAccountId: account.socialAccountId,
            credentialReferenceId,
            expiresAt: outcome.expiresAt,
            expectedVersion: locked.version,
          },
          provenance,
        );
        await store.insertGrantScopes(tx, {
          grantId: grant.grantId,
          grantedScopes: outcome.grantedScopes,
          capabilityTags: outcome.capabilityTags,
        });
        await store.appendEvent(
          tx,
          composeGrantCompletedEvent(
            { socialAccountId: account.socialAccountId, grantId: grant.grantId },
            provenance,
          ),
        );
        return { account, grant };
      });
      return {
        account,
        grant,
        scopeFacts: {
          grantedScopes: [...outcome.grantedScopes],
          capabilityTags: [...outcome.capabilityTags],
        },
      };
    },

    async refreshAuthorization(input, provenance) {
      assertValidProvenance(provenance);

      const account = await store.getAccount(input.socialAccountId);
      if (account === null) {
        throw new NotFoundError('social account', input.socialAccountId);
      }
      if (account.status !== 'connected') {
        throw new ConflictError(
          `social account ${account.socialAccountId} is '${account.status}'; a disconnected/revoked connection can never refresh (fail-closed)`,
        );
      }

      const current = await store.getCurrentAuthorizedGrant(account.socialAccountId);
      if (current === null || !isGrantRefreshable(current.grantState)) {
        throw new ConflictError(
          `social account ${account.socialAccountId} holds no refreshable grant (authorized or expired) — reauthorize instead`,
        );
      }
      const ownership = await requireConnectionOwnership(
        account.integrationConnectionId,
        account.clientId,
      );
      requireConnectedIntegration(ownership);
      const flow = requireFlow(ownership.connection.adapterKey);

      // FAIL-CLOSED gates: network egress for the refresh, then the
      // credential use for the call. Deny/unknown → PolicyDeniedError
      // BEFORE any material resolution or provider traffic.
      await requirePolicyAllow(
        {
          dimension: 'network',
          operation: 'social-account.refresh',
          resource: ownership.connection.adapterKey,
          attributes: { platform: ownership.connection.adapterKey },
        },
        {
          agencyId: ownership.connection.agencyId,
          clientId: ownership.connection.clientId,
        },
        provenance,
      );
      await requirePolicyAllow(
        {
          dimension: 'secrets',
          operation: 'social-account.credential',
          resource: current.credentialReferenceId,
          attributes: { platform: ownership.connection.adapterKey },
        },
        {
          agencyId: ownership.connection.agencyId,
          clientId: ownership.connection.clientId,
        },
        provenance,
      );

      const material = await resolveTokenMaterial(ownership, current.credentialReferenceId!);
      const outcome = await flow.refreshAuthorization(
        flowContext(ownership, account.workspaceId),
        { currentTokenMaterial: material },
      );
      validateExchangeOutcome(outcome);
      if (outcome.identity.externalAccountId !== account.externalAccountId) {
        throw new ConflictError(
          `the refresh returned external account '${outcome.identity.externalAccountId}' but the binding is '${account.externalAccountId}' — the platform identity of a binding is frozen (fail-closed)`,
        );
      }

      // The successor's OWN new vault reference (created before any state
      // change — a dangling handle aborts with zero rows; the predecessor's
      // reference dies next — the disable-first ordering), then the
      // append-only transition pair inside ONE transaction: the old grant
      // moves to 'refreshed' with the successor link and the new grant is
      // born authorized.
      const successorGrantId = deps.ids.newId();
      const successorReferenceId = await createTokenReference({
        agencyId: ownership.connection.agencyId,
        clientId: ownership.connection.clientId,
        platformId: ownership.connection.adapterKey,
        grantId: successorGrantId,
        tokenSecretHandle: outcome.tokenSecretHandle,
      });
      await disableTokenReference(current.credentialReferenceId!);

      const grant = await db.transaction(async (tx) => {
        const locked = await store.lockGrant(tx, current.grantId);
        if (
          locked === null
          || !isGrantRefreshable(locked.grantState)
          || locked.credentialReferenceId !== current.credentialReferenceId
        ) {
          throw new ConflictError(
            `grant ${current.grantId} lost the refresh race — retry the operation`,
          );
        }
        await store.transitionGrantState(tx, {
          grantId: locked.grantId,
          grantState: 'refreshed',
          successorGrantId,
          expectedVersion: locked.version,
        });
        const successor = await store.insertAuthorizedSuccessorGrant(
          tx,
          {
            grantId: successorGrantId,
            integrationConnectionId: ownership.connection.connectionId,
            agencyId: ownership.connection.agencyId,
            clientId: ownership.connection.clientId,
            workspaceId: account.workspaceId,
            socialAccountId: account.socialAccountId,
            platformId: ownership.connection.adapterKey,
            stateToken: deps.ids.newId(),
            requestedScopes: current.requestedScopes,
            credentialReferenceId: successorReferenceId,
            expiresAt: outcome.expiresAt,
            startedByProvenance: provenance,
          },
          provenance,
        );
        await store.appendEvent(
          tx,
          composeSocialAccountEvent(
            {
              socialAccountId: account.socialAccountId,
              grantId: locked.grantId,
              eventType: 'grant_refreshed',
              initiatedBy: 'operator',
              reason: null,
              providerRevokeOutcome: null,
            },
            provenance,
          ),
        );
        return successor;
      });
      await store.insertGrantScopes(db, {
        grantId: grant.grantId,
        grantedScopes: outcome.grantedScopes,
        capabilityTags: outcome.capabilityTags,
      });
      return {
        account,
        grant,
        scopeFacts: {
          grantedScopes: [...outcome.grantedScopes],
          capabilityTags: [...outcome.capabilityTags],
        },
      };
    },

    async expireAuthorizationGrant(input, provenance) {
      assertValidProvenance(provenance);
      assertValidReason(input.reason);

      const grant = await store.getGrant(input.grantId);
      if (grant === null) {
        throw new NotFoundError('authorization grant', input.grantId);
      }
      if (grant.grantState !== 'authorized' && grant.grantState !== 'pending') {
        throw new ConflictError(
          `grant ${input.grantId} is '${grant.grantState}' — only an authorized (or a stale pending) grant can be marked expired`,
        );
      }
      await db.transaction(async (tx) => {
        await store.transitionGrantState(tx, {
          grantId: grant.grantId,
          grantState: 'expired',
          successorGrantId: null,
          expectedVersion: grant.version,
        });
        await store.appendEvent(
          tx,
          composeSocialAccountEvent(
            {
              socialAccountId: grant.socialAccountId,
              grantId: grant.grantId,
              eventType: 'authorization_expired',
              initiatedBy: 'operator',
              reason: input.reason,
              providerRevokeOutcome: null,
            },
            provenance,
          ),
        );
      });
      const updated = await store.getGrant(grant.grantId);
      if (updated === null) {
        throw new Error(`expired grant ${grant.grantId} could not be read back`);
      }
      return updated;
    },

    async disconnectAccount(input, provenance) {
      assertValidProvenance(provenance);
      assertValidReason(input.reason);

      const account = await store.getAccount(input.socialAccountId);
      if (account === null) {
        throw new NotFoundError('social account', input.socialAccountId);
      }
      if (account.status !== 'connected') {
        throw new ConflictError(
          `social account ${account.socialAccountId} is already '${account.status}' (terminal)`,
        );
      }
      const ownership = await requireConnectionOwnership(
        account.integrationConnectionId,
        account.clientId,
      );

      // The best-effort provider-side revocation: policy-gated, in-process
      // material; the outcome is DISCLOSURE on the event — the MOS-side
      // death happens regardless.
      let providerRevokeOutcome: 'not-requested' | 'revoked' | 'skipped-policy-denied' | 'failed' =
        'not-requested';
      const liveGrants = await liveGrantsOf(account.socialAccountId);
      const current = liveGrants.find((grant) => grant.grantState === 'authorized') ?? null;

      if (input.revokeAtProvider && current !== null && current.credentialReferenceId !== null) {
        const flow = requireFlow(ownership.connection.adapterKey);
        let policyAllowed = true;
        try {
          await requirePolicyAllow(
            {
              dimension: 'network',
              operation: 'social-account.revoke',
              resource: ownership.connection.adapterKey,
              attributes: { platform: ownership.connection.adapterKey },
            },
            {
              agencyId: ownership.connection.agencyId,
              clientId: ownership.connection.clientId,
            },
            provenance,
          );
          await requirePolicyAllow(
            {
              dimension: 'secrets',
              operation: 'social-account.credential',
              resource: current.credentialReferenceId,
              attributes: { platform: ownership.connection.adapterKey },
            },
            {
              agencyId: ownership.connection.agencyId,
              clientId: ownership.connection.clientId,
            },
            provenance,
          );
        } catch (error) {
          if (error instanceof PolicyDeniedError) {
            policyAllowed = false;
          } else {
            throw error;
          }
        }
        if (policyAllowed) {
          try {
            const material = await resolveTokenMaterial(ownership, current.credentialReferenceId);
            const revokeOutcome = await flow.revokeAuthorization(
              flowContext(ownership, account.workspaceId),
              { currentTokenMaterial: material },
            );
            providerRevokeOutcome = revokeOutcome.revoked ? 'revoked' : 'failed';
          } catch {
            providerRevokeOutcome = 'failed';
          }
        } else {
          providerRevokeOutcome = 'skipped-policy-denied';
        }
      }

      // The vault references die FIRST (no zombie grants), then the
      // durable death inside ONE transaction: the live grants are
      // revoked, the binding moves to the terminal state and every event
      // is appended.
      for (const grant of liveGrants) {
        if (grant.credentialReferenceId !== null) {
          await disableTokenReference(grant.credentialReferenceId);
        }
      }
      await db.transaction(async (tx) => {
        for (const grant of liveGrants) {
          await store.transitionGrantState(tx, {
            grantId: grant.grantId,
            grantState: 'revoked',
            successorGrantId: null,
            expectedVersion: grant.version,
          });
          await store.appendEvent(
            tx,
            composeSocialAccountEvent(
              {
                socialAccountId: account.socialAccountId,
                grantId: grant.grantId,
                eventType: 'authorization_revoked',
                initiatedBy: 'operator',
                reason: input.reason ?? 'account disconnected',
                providerRevokeOutcome: null,
              },
              provenance,
            ),
          );
        }
        await store.transitionAccountStatus(tx, {
          socialAccountId: account.socialAccountId,
          status: 'disconnected',
          expectedVersion: account.version,
        });
        await store.appendEvent(
          tx,
          composeSocialAccountEvent(
            {
              socialAccountId: account.socialAccountId,
              grantId: null,
              eventType: 'account_disconnected',
              initiatedBy: 'operator',
              reason: input.reason,
              providerRevokeOutcome,
            },
            provenance,
          ),
        );
      });

      const updated = await store.getAccount(account.socialAccountId);
      if (updated === null) {
        throw new Error(`disconnected social account ${account.socialAccountId} could not be read back`);
      }
      return updated;
    },

    async recordExternalRevocation(input, provenance) {
      assertValidProvenance(provenance);
      assertValidReason(input.reason);
      if (!SIGNALLED_VIA_PATTERN.test(input.signalledVia)) {
        throw new ConflictError(
          'signalledVia must be a normalized signal label (e.g. adapter or relay identity)',
        );
      }

      const account = await store.getAccount(input.socialAccountId);
      if (account === null) {
        throw new NotFoundError('social account', input.socialAccountId);
      }
      if (account.status !== 'connected') {
        throw new ConflictError(
          `social account ${account.socialAccountId} is already '${account.status}' (terminal)`,
        );
      }

      // The externally-signalled death: identical failure modes to the
      // operator disconnect — the live grants are revoked, the vault
      // references die, the binding moves to the terminal 'revoked'
      // state. The signal source is recorded on the reason.
      const reason =
        input.reason === null
          ? `external revocation signalled via ${input.signalledVia}`
          : `external revocation signalled via ${input.signalledVia}: ${input.reason}`;
      const liveGrants = await liveGrantsOf(account.socialAccountId);
      for (const grant of liveGrants) {
        if (grant.credentialReferenceId !== null) {
          await disableTokenReference(grant.credentialReferenceId);
        }
      }
      await db.transaction(async (tx) => {
        for (const grant of liveGrants) {
          await store.transitionGrantState(tx, {
            grantId: grant.grantId,
            grantState: 'revoked',
            successorGrantId: null,
            expectedVersion: grant.version,
          });
          await store.appendEvent(
            tx,
            composeSocialAccountEvent(
              {
                socialAccountId: account.socialAccountId,
                grantId: grant.grantId,
                eventType: 'authorization_revoked',
                initiatedBy: 'external-signal',
                reason,
                providerRevokeOutcome: null,
              },
              provenance,
            ),
          );
        }
        await store.transitionAccountStatus(tx, {
          socialAccountId: account.socialAccountId,
          status: 'revoked',
          expectedVersion: account.version,
        });
        await store.appendEvent(
          tx,
          composeSocialAccountEvent(
            {
              socialAccountId: account.socialAccountId,
              grantId: null,
              eventType: 'account_revoked',
              initiatedBy: 'external-signal',
              reason,
              providerRevokeOutcome: null,
            },
            provenance,
          ),
        );
      });

      const updated = await store.getAccount(account.socialAccountId);
      if (updated === null) {
        throw new Error(`revoked social account ${account.socialAccountId} could not be read back`);
      }
      return updated;
    },

    async getUsableAuthorization(socialAccountId) {
      const account = await store.getAccount(socialAccountId);
      if (account === null || account.status !== 'connected') return null;
      const grant = await store.getCurrentAuthorizedGrant(socialAccountId);
      if (grant === null) return null;
      // LAZY EXPIRY: an authorized grant whose token expiry has passed is
      // NOT usable (the recorded 'expired' state is the observation; this
      // is the enforcement — belt and braces).
      if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now()) {
        return null;
      }
      const scopeFacts = await store.getGrantScopeFacts(grant.grantId);
      return {
        account,
        grant,
        scopeFacts,
        credentialReferenceId: grant.credentialReferenceId!,
      };
    },

    async getSocialAccount(socialAccountId) {
      return store.getAccount(socialAccountId);
    },

    async resolveAccountOwnership(socialAccountId) {
      const account = await store.getAccount(socialAccountId);
      if (account === null) return null;
      const connectionOwnership = await integrations.resolveConnectionOwnership(
        account.integrationConnectionId,
      );
      if (connectionOwnership === null) return null;
      if (connectionOwnership.connection.agencyId !== account.agencyId) return null;
      return composeSocialAccountOwnerContext(account, connectionOwnership, clock.nowIso());
    },

    async listSocialAccountsForClient(clientId) {
      return store.listAccountsForClient(clientId);
    },

    async listSocialAccountsForWorkspace(workspaceId) {
      return store.listAccountsForWorkspace(workspaceId);
    },

    async getAuthorizationGrant(grantId) {
      const grant = await store.getGrant(grantId);
      if (grant === null) {
        throw new NotFoundError('authorization grant', grantId);
      }
      // THE FAIL-CLOSED GRANT READ (AC-5): a dead connection's grant
      // never surfaces — the grant row carries the credential reference,
      // so a disconnected/revoked connection exposes no authorization
      // facts. History without authorization payload stays readable
      // through the event tail.
      if (grant.socialAccountId !== null) {
        const account = await store.getAccount(grant.socialAccountId);
        if (account === null || account.status !== 'connected') {
          throw new ConflictError(
            `social account ${grant.socialAccountId} is '${account?.status ?? 'unknown'}' — every read of a disconnected/revoked connection's grant refuses (fail-closed)`,
          );
        }
      }
      if (grant.grantState === 'revoked') {
        throw new ConflictError(
          `grant ${grant.grantId} is 'revoked' — every read of a revoked grant refuses (fail-closed)`,
        );
      }
      return grant;
    },

    async listAuthorizationGrantsForAccount(socialAccountId) {
      const account = await store.getAccount(socialAccountId);
      if (account === null) {
        throw new NotFoundError('social account', socialAccountId);
      }
      if (account.status !== 'connected') {
        throw new ConflictError(
          `social account ${socialAccountId} is '${account.status}' — every read of a disconnected/revoked connection's grant refuses (fail-closed)`,
        );
      }
      return store.listGrantsForAccount(socialAccountId);
    },

    async listAccountEvents(socialAccountId) {
      const account = await store.getAccount(socialAccountId);
      if (account === null) {
        throw new NotFoundError('social account', socialAccountId);
      }
      return store.listEventsForAccount(socialAccountId);
    },

    async getAuthorizationGrantScopeFacts(grantId) {
      await this.getAuthorizationGrant(grantId);
      return store.getGrantScopeFacts(grantId);
    },
  };
}
