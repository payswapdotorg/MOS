/**
 * Creator Operations Domain Pack — the pack SERVICE (MKT-037, CREATOR-001).
 *
 * Composition over the pack store with the platform authorities reached
 * EXCLUSIVELY through the structural ports of contract.ts (the
 * /metrics-for-/clients precedent — see the contract header):
 *
 *   - every WRITE resolves the canonical Client chain THROUGH the /clients
 *     port BEFORE any SQL (unknown or tombstoned Client → uniform 404;
 *     disabled Client → 409 — the /evidence posture; the migration-031
 *     scope triggers are the race backstop);
 *   - the §7 observation mapping appends through the /evidence + /metrics
 *     ports with server-derived provenance (the pack owns the mapping —
 *     CREATOR-AC-02);
 *   - the CREATOR-AC-06 gates evaluate the sensitive actions through the
 *     /policies port (fail-closed: only an explicit 'allow' writes the
 *     side-effect row; the approvalStatus attribute is composed
 *     SERVER-SIDE from the pack-owned approval record state);
 *   - the §5 AI task declarations register as REAL TaskProfiles through
 *     the /ai-runtime port (CREATOR-AC-03);
 *   - the frozen manifest publishes through the SAME-MODULE /domain-packs
 *     framework authority (intra-module public-contract import).
 *
 * Fail-closed contract: every guard throws before any state is touched;
 * unknown ids surface the uniform NotFoundError (foreign and unknown are
 * indistinguishable); CAS races surface ConflictError; policy
 * deny/unknown/error surface PolicyDeniedError BEFORE any write.
 */

import { ConflictError, InvalidRequestError, NotFoundError, PolicyDeniedError } from '../../../../../platform/errors/errors.ts';
import type {
  CreatorAccountRecord,
  CreatorContentAssetRecord,
  CreatorConversationRecord,
  CreatorFanRecord,
  CreatorObservationReceipt,
  CreatorOfferRecord,
  CreatorOperationApprovalRecord,
  CreatorOperationsPackApi,
  CreatorOperationsPackDeps,
  CreatorProfileRecord,
  CreatorTaskProfileProvisionReceipt,
} from './contract.ts';
import {
  CREATOR_GATE_APPROVAL_ATTRIBUTE,
  CREATOR_GATE_POLICY_DIMENSION,
  creatorEnforcementOutcome,
  isLegalCreatorAccountTransition,
  isLegalCreatorContentTransition,
  isLegalCreatorConversationTransition,
  isLegalCreatorFanTransition,
  isLegalCreatorOfferTransition,
} from './contract.ts';
import {
  assertValidCreatorAccountInput,
  assertValidCreatorAccountStatusInput,
  assertValidCreatorApprovalInput,
  assertValidCreatorContentAssetInput,
  assertValidCreatorContentTransitionInput,
  assertValidCreatorConversationInput,
  assertValidCreatorConversationStatusInput,
  assertValidCreatorFanInput,
  assertValidCreatorFanStatusInput,
  assertValidCreatorMessageInput,
  assertValidCreatorObservationInput,
  assertValidCreatorOfferInput,
  assertValidCreatorOfferStatusInput,
  assertValidCreatorProfileInput,
  assertValidCreatorProvenance,
  assertValidCreatorTaskProfileProvisionInput,
} from './guards.ts';
import {
  CREATOR_OPERATIONS_PACK_MANIFEST,
  CREATOR_TASK_PROFILE_DECLARATIONS,
} from './manifest.ts';
import { CreatorOperationsStore } from './store.ts';

export function createCreatorOperationsPack(
  deps: CreatorOperationsPackDeps,
): CreatorOperationsPackApi {
  const store = new CreatorOperationsStore(deps.db, deps.clock, deps.ids);

  /**
   * Canonical Client chain resolution THROUGH the /clients port BEFORE
   * any write (CREATOR-AC-01: pack-owned records resolve through the
   * EXISTING Client boundary). Unknown or tombstoned Client → uniform
   * 404; disabled Client → 409 (new use blocked without rewriting
   * history — the /evidence posture).
   */
  async function resolveClientChain(clientId: string): Promise<{ agencyId: string; clientId: string }> {
    const ownership = await deps.clients.resolveClientOwnership(clientId);
    if (ownership === null) {
      throw new NotFoundError('client', clientId);
    }
    if (ownership.client.status !== 'active') {
      throw new ConflictError(
        `client ${clientId} is ${ownership.client.status}; creator operations cannot record against it`,
      );
    }
    return { agencyId: ownership.scope.agencyId, clientId: ownership.scope.clientId };
  }

  /** Profile row or uniform 404. */
  async function profileOr404(profileId: string): Promise<CreatorProfileRecord> {
    const profile = await store.getCreatorProfile(profileId);
    if (profile === null) {
      throw new NotFoundError('creator profile', profileId);
    }
    return profile;
  }

  /** Account row or uniform 404. */
  async function accountOr404(accountId: string): Promise<CreatorAccountRecord> {
    const account = await store.getCreatorAccount(accountId);
    if (account === null) {
      throw new NotFoundError('creator account', accountId);
    }
    return account;
  }

  /** Fan row or uniform 404. */
  async function fanOr404(fanId: string): Promise<CreatorFanRecord> {
    const fan = await store.getCreatorFan(fanId);
    if (fan === null) {
      throw new NotFoundError('creator fan', fanId);
    }
    return fan;
  }

  /** Conversation row or uniform 404. */
  async function conversationOr404(conversationId: string): Promise<CreatorConversationRecord> {
    const conversation = await store.getCreatorConversation(conversationId);
    if (conversation === null) {
      throw new NotFoundError('creator conversation', conversationId);
    }
    return conversation;
  }

  /** Content asset row or uniform 404. */
  async function contentAssetOr404(assetId: string): Promise<CreatorContentAssetRecord> {
    const asset = await store.getCreatorContentAsset(assetId);
    if (asset === null) {
      throw new NotFoundError('creator content asset', assetId);
    }
    return asset;
  }

  /** Offer row or uniform 404. */
  async function offerOr404(offerId: string): Promise<CreatorOfferRecord> {
    const offer = await store.getCreatorOffer(offerId);
    if (offer === null) {
      throw new NotFoundError('creator offer', offerId);
    }
    return offer;
  }

  /**
   * Validates the approval record presented to a gate: it must exist, be
   * of the expected ACTION and DECISION, target THIS resource, and belong
   * to the SAME Client (a foreign approval id is indistinguishable from
   * an unknown one — no cross-tenant oracle). Returns the valid record or
   * null when none was presented.
   */
  async function validGateApprovalOrNull(
    approvalId: string | null,
    expectedAction: 'creator.conversation.send' | 'creator.content.publish',
    resourceId: string,
    clientId: string,
  ): Promise<CreatorOperationApprovalRecord | null> {
    if (approvalId === null) return null;
    const approval = await store.getCreatorApproval(approvalId);
    if (approval === null || approval.clientId !== clientId) {
      throw new NotFoundError('creator operation approval', approvalId);
    }
    if (approval.action !== expectedAction) {
      throw new InvalidRequestError(
        `creator operation approval ${approvalId} covers action '${approval.action}', not '${expectedAction}'`,
      );
    }
    if (approval.resourceId !== resourceId) {
      throw new InvalidRequestError(
        `creator operation approval ${approvalId} covers resource ${approval.resourceId}, not ${resourceId}`,
      );
    }
    if (approval.decision !== 'approved') {
      throw new InvalidRequestError(
        `creator operation approval ${approvalId} is '${approval.decision}' — only an approved record can satisfy the gate`,
      );
    }
    return approval;
  }

  /**
   * THE CREATOR-AC-06 GATE: evaluates one sensitive action through the
   * /policies port with the SERVER-COMPOSED approvalStatus attribute
   * ('approved' when a valid pack approval record was presented,
   * 'missing' otherwise — never caller-supplied) and returns the decision
   * id ONLY on an explicit allow. Everything else is a PolicyDeniedError
   * BEFORE any write.
   */
  async function evaluateGate(input: {
    readonly operation: 'creator.conversation.send' | 'creator.content.publish';
    readonly resourceId: string;
    readonly agencyId: string;
    readonly clientId: string;
    readonly approval: CreatorOperationApprovalRecord | null;
    readonly provenance: { actor: string; recordedVia: string; correlationId: string; causationId: string | null };
  }): Promise<string> {
      const decision = await deps.policies.evaluateAction(
      {
        action: {
          dimension: CREATOR_GATE_POLICY_DIMENSION,
          operation: input.operation,
          resource: input.resourceId,
          attributes: {
            [CREATOR_GATE_APPROVAL_ATTRIBUTE]:
              input.approval === null ? 'missing' : 'approved',
          },
        },
        scope: { agencyId: input.agencyId, clientId: input.clientId },
      },
      input.provenance,
    );
    if (creatorEnforcementOutcome(decision) !== 'allow') {
      throw new PolicyDeniedError(
        `creator operation '${input.operation}' on ${input.resourceId} was denied by the policy boundary (${decision.reasonCode}) — the gate fails closed without an explicit allow`,
      );
    }
    return decision.decisionId;
  }

  /** Maps a CAS store outcome to the typed error surface. */
  function casOutcomeError(subject: string, id: string): never {
    throw new NotFoundError(subject, id);
  }

  function throwCasConflict(subject: string, id: string): never {
    throw new ConflictError(`${subject} ${id} was modified concurrently (CAS mismatch)`);
  }

  return {
    // ----- Profiles ---------------------------------------------------------

    async recordCreatorProfile(input, actorId) {
      assertValidCreatorProfileInput(input);
      const chain = await resolveClientChain(input.clientId);
      const outcome = await store.insertCreatorProfile(
        {
          clientId: chain.clientId,
          agencyId: chain.agencyId,
          displayName: input.displayName,
          handle: input.handle,
          niches: input.niches,
          bio: input.bio,
          attributes: input.attributes,
        },
        actorId,
      );
      return outcome.record;
    },

    async getCreatorProfile(profileId) {
      return store.getCreatorProfile(profileId);
    },

    async listCreatorProfilesForClient(clientId) {
      return store.listCreatorProfilesForClient(clientId);
    },

    // ----- Accounts ----------------------------------------------------------

    async recordCreatorAccount(input, actorId) {
      assertValidCreatorAccountInput(input);
      const profile = await profileOr404(input.profileId);
      const chain = await resolveClientChain(profile.clientId);
      const outcome = await store.insertCreatorAccount(
        {
          clientId: chain.clientId,
          agencyId: chain.agencyId,
          profileId: profile.profileId,
          platformLabel: input.platformLabel,
          accountHandle: input.accountHandle,
          metadata: input.metadata,
        },
        actorId,
      );
      return outcome.record;
    },

    async getCreatorAccount(accountId) {
      return store.getCreatorAccount(accountId);
    },

    async listCreatorAccountsForProfile(profileId) {
      return store.listCreatorAccountsForProfile(profileId);
    },

    async setCreatorAccountStatus(input) {
      assertValidCreatorAccountStatusInput(input);
      const current = await accountOr404(input.accountId);
      if (!isLegalCreatorAccountTransition(current.status, input.status)) {
        throw new ConflictError(
          `illegal creator account transition ${current.status} → ${input.status} (the frozen lifecycle is active ⇄ paused with the terminal retire edge)`,
        );
      }
      const outcome = await store.setCreatorAccountStatus(input, input.actorId);
      if (typeof outcome === 'string') {
        if (outcome === 'not-found') casOutcomeError('creator account', input.accountId);
        throwCasConflict('creator account', input.accountId);
      }
      return outcome;
    },

    // ----- Fans ---------------------------------------------------------------

    async recordCreatorFan(input, actorId) {
      assertValidCreatorFanInput(input);
      const account = await accountOr404(input.accountId);
      const chain = await resolveClientChain(account.clientId);
      const outcome = await store.insertCreatorFan(
        {
          clientId: chain.clientId,
          agencyId: chain.agencyId,
          accountId: account.accountId,
          fanAlias: input.fanAlias,
          tier: input.tier,
          tags: input.tags,
          attributes: input.attributes,
        },
        actorId,
      );
      return outcome.record;
    },

    async getCreatorFan(fanId) {
      return store.getCreatorFan(fanId);
    },

    async listCreatorFansForAccount(accountId) {
      return store.listCreatorFansForAccount(accountId);
    },

    async setCreatorFanStatus(input) {
      assertValidCreatorFanStatusInput(input);
      const current = await fanOr404(input.fanId);
      if (!isLegalCreatorFanTransition(current.status, input.status)) {
        throw new ConflictError(
          `illegal creator fan transition ${current.status} → ${input.status} (the frozen lifecycle is subscribed ⇄ churned with the terminal remove edge)`,
        );
      }
      const outcome = await store.setCreatorFanStatus(input, input.actorId);
      if (typeof outcome === 'string') {
        if (outcome === 'not-found') casOutcomeError('creator fan', input.fanId);
        throwCasConflict('creator fan', input.fanId);
      }
      return outcome;
    },

    // ----- Conversations --------------------------------------------------------

    async openCreatorConversation(input, actorId) {
      assertValidCreatorConversationInput(input);
      const account = await accountOr404(input.accountId);
      const fan = await fanOr404(input.fanId);
      if (fan.accountId !== account.accountId) {
        throw new ConflictError(
          `creator fan ${input.fanId} does not belong to creator account ${input.accountId} — the conversation chain cannot cross accounts`,
        );
      }
      const chain = await resolveClientChain(account.clientId);
      const outcome = await store.insertCreatorConversation(
        {
          clientId: chain.clientId,
          agencyId: chain.agencyId,
          accountId: account.accountId,
          fanId: fan.fanId,
          channel: input.channel,
          topic: input.topic,
          attributes: input.attributes,
        },
        actorId,
      );
      return outcome.record;
    },

    async getCreatorConversation(conversationId) {
      return store.getCreatorConversation(conversationId);
    },

    async listCreatorConversationsForAccount(accountId) {
      return store.listCreatorConversationsForAccount(accountId);
    },

    async setCreatorConversationStatus(input) {
      assertValidCreatorConversationStatusInput(input);
      const current = await conversationOr404(input.conversationId);
      if (!isLegalCreatorConversationTransition(current.status, input.status)) {
        throw new ConflictError(
          `illegal creator conversation transition ${current.status} → ${input.status} (the frozen lifecycle is open ⇄ paused with the terminal close edge)`,
        );
      }
      const outcome = await store.setCreatorConversationStatus(input, input.actorId);
      if (typeof outcome === 'string') {
        if (outcome === 'not-found') casOutcomeError('creator conversation', input.conversationId);
        throwCasConflict('creator conversation', input.conversationId);
      }
      return outcome;
    },

    // ----- Messages -------------------------------------------------------------

    async recordCreatorInboundMessage(input, actorId, provenance) {
      assertValidCreatorMessageInput(input);
      if (input.mapToEvidence && provenance !== null) {
        assertValidCreatorProvenance(provenance);
      }
      const conversation = await conversationOr404(input.conversationId);
      if (conversation.status !== 'open' && conversation.status !== 'paused') {
        throw new ConflictError(
          `creator conversation ${input.conversationId} is ${conversation.status}; inbound observations are recorded only on live conversations`,
        );
      }
      const chain = await resolveClientChain(conversation.clientId);

      // Fast replay convergence: a duplicate of the same logical message
      // command returns the recorded row (the §8-style key).
      const existing = await store.findCreatorMessageByIdempotency(
        input.conversationId,
        input.idempotencyKey,
      );
      if (existing !== null) {
        return existing;
      }

      // The §7 observation mapping (when requested): the inbound message
      // enters the COMMON evidence ledger THROUGH the port — the pack
      // owns the mapping, never a parallel store. The receipt is stamped
      // on the immutable message row at insert.
      let evidenceRef: string | null = null;
      if (input.mapToEvidence && provenance !== null) {
        const receipt = await deps.evidence.appendEvidence(
          {
            clientId: chain.clientId,
            workspaceId: null,
            class: 'observation',
            source: { system: 'creator-operations', ref: conversation.conversationId },
            observedAt: deps.clock.nowIso(),
            content: {
              subjectKind: 'conversation',
              subjectRef: conversation.conversationId,
              eventKind: 'message_received',
              channel: conversation.channel,
              bodyPreview: input.body.slice(0, 200),
            },
            contentRef: null,
            quality: 'C',
            confidence: null,
            supersedesEvidenceId: null,
          },
          provenance,
        );
        evidenceRef = receipt.evidenceId;
      }

      const outcome = await store.insertCreatorMessage(
        {
          clientId: chain.clientId,
          agencyId: chain.agencyId,
          conversationId: conversation.conversationId,
          direction: 'inbound',
          status: 'received',
          body: input.body,
          policyDecisionId: null,
          approvalId: null,
          evidenceRef,
          idempotencyKey: input.idempotencyKey,
        },
        actorId,
      );
      return outcome.record;
    },

    async sendCreatorOutboundMessage(input, actorId, provenance) {
      assertValidCreatorMessageInput(input);
      assertValidCreatorProvenance(provenance);
      const conversation = await conversationOr404(input.conversationId);
      if (conversation.status !== 'open') {
        throw new ConflictError(
          `creator conversation ${input.conversationId} is ${conversation.status}; outbound sends require an open conversation`,
        );
      }
      const chain = await resolveClientChain(conversation.clientId);

      // Fast replay convergence: a duplicate of the same logical send
      // command returns the recorded row (the gate already allowed it).
      const existing = await store.findCreatorMessageByIdempotency(
        input.conversationId,
        input.idempotencyKey,
      );
      if (existing !== null) {
        return existing;
      }

      // THE CREATOR-AC-06 GATE: validate the presented approval record,
      // compose the approvalStatus attribute SERVER-SIDE, evaluate the
      // policy action, and only an explicit 'allow' reaches the insert.
      const approval = await validGateApprovalOrNull(
        input.approvalId,
        'creator.conversation.send',
        conversation.conversationId,
        chain.clientId,
      );
      const decisionId = await evaluateGate({
        operation: 'creator.conversation.send',
        resourceId: conversation.conversationId,
        agencyId: chain.agencyId,
        clientId: chain.clientId,
        approval,
        provenance,
      });

      const outcome = await store.insertCreatorMessage(
        {
          clientId: chain.clientId,
          agencyId: chain.agencyId,
          conversationId: conversation.conversationId,
          direction: 'outbound',
          status: 'sent',
          body: input.body,
          policyDecisionId: decisionId,
          approvalId: approval === null ? null : approval.approvalId,
          evidenceRef: null,
          idempotencyKey: input.idempotencyKey,
        },
        actorId,
      );
      return outcome.record;
    },

    async listCreatorMessages(conversationId) {
      return store.listCreatorMessages(conversationId);
    },

    // ----- Content assets -------------------------------------------------------

    async recordCreatorContentAsset(input, actorId) {
      assertValidCreatorContentAssetInput(input);
      const profile = await profileOr404(input.profileId);
      const chain = await resolveClientChain(profile.clientId);
      const outcome = await store.insertCreatorContentAsset(
        {
          clientId: chain.clientId,
          agencyId: chain.agencyId,
          profileId: profile.profileId,
          title: input.title,
          contentKind: input.contentKind,
          plannedPlatforms: input.plannedPlatforms,
          brief: input.brief,
          attributes: input.attributes,
        },
        actorId,
      );
      return outcome.record;
    },

    async getCreatorContentAsset(assetId) {
      return store.getCreatorContentAsset(assetId);
    },

    async listCreatorContentAssetsForProfile(profileId) {
      return store.listCreatorContentAssetsForProfile(profileId);
    },

    async transitionCreatorContentAsset(input) {
      assertValidCreatorContentTransitionInput(input);
      if (input.status === 'published' && input.provenance !== null) {
        assertValidCreatorProvenance(input.provenance);
      }
      const asset = await contentAssetOr404(input.assetId);
      if (!isLegalCreatorContentTransition(asset.status, input.status)) {
        throw new ConflictError(
          `illegal creator content asset transition ${asset.status} → ${input.status} (the frozen lifecycle is draft → in_review → approved → published with the terminal reject side-exits)`,
        );
      }

      if (input.status !== 'published') {
        const outcome = await store.transitionCreatorContentAsset({
          assetId: asset.assetId,
          status: input.status,
          expectedVersion: input.expectedVersion,
          policyDecisionId: null,
          approvalId: null,
        });
        if (typeof outcome === 'string') {
          if (outcome === 'not-found') casOutcomeError('creator content asset', input.assetId);
          throwCasConflict('creator content asset', input.assetId);
        }
        return outcome;
      }

      // THE PUBLISHED EDGE — the CREATOR-AC-06 gated side effect.
      const chain = await resolveClientChain(asset.clientId);
      const approval = await validGateApprovalOrNull(
        input.approvalId,
        'creator.content.publish',
        asset.assetId,
        chain.clientId,
      );
      const provenance = input.provenance;
      if (provenance === null) {
        // The guard already enforces this; defensive fail-closed.
        throw new InvalidRequestError(
          'provenance is required for the published edge (the approval-gated side effect)',
        );
      }
      const decisionId = await evaluateGate({
        operation: 'creator.content.publish',
        resourceId: asset.assetId,
        agencyId: chain.agencyId,
        clientId: chain.clientId,
        approval,
        provenance,
      });

      const outcome = await store.transitionCreatorContentAsset({
        assetId: asset.assetId,
        status: input.status,
        expectedVersion: input.expectedVersion,
        policyDecisionId: decisionId,
        approvalId: approval === null ? null : approval.approvalId,
      });
      if (typeof outcome === 'string') {
        if (outcome === 'not-found') casOutcomeError('creator content asset', input.assetId);
        throwCasConflict('creator content asset', input.assetId);
      }
      return outcome;
    },

    // ----- Offers ---------------------------------------------------------------

    async recordCreatorOffer(input, actorId) {
      assertValidCreatorOfferInput(input);
      const profile = await profileOr404(input.profileId);
      const chain = await resolveClientChain(profile.clientId);
      const outcome = await store.insertCreatorOffer(
        {
          clientId: chain.clientId,
          agencyId: chain.agencyId,
          profileId: profile.profileId,
          title: input.title,
          offerKind: input.offerKind,
          priceCents: input.priceCents,
          currency: input.currency,
          terms: input.terms,
          attributes: input.attributes,
        },
        actorId,
      );
      return outcome.record;
    },

    async getCreatorOffer(offerId) {
      return store.getCreatorOffer(offerId);
    },

    async listCreatorOffersForProfile(profileId) {
      return store.listCreatorOffersForProfile(profileId);
    },

    async setCreatorOfferStatus(input) {
      assertValidCreatorOfferStatusInput(input);
      const current = await offerOr404(input.offerId);
      if (!isLegalCreatorOfferTransition(current.status, input.status)) {
        throw new ConflictError(
          `illegal creator offer transition ${current.status} → ${input.status} (the frozen lifecycle is draft → active ⇄ paused with the terminal retire edge)`,
        );
      }
      const outcome = await store.setCreatorOfferStatus(input, input.actorId);
      if (typeof outcome === 'string') {
        if (outcome === 'not-found') casOutcomeError('creator offer', input.offerId);
        throwCasConflict('creator offer', input.offerId);
      }
      return outcome;
    },

    // ----- Approvals ---------------------------------------------------------------

    async recordCreatorOperationApproval(input, actorId, provenance) {
      assertValidCreatorApprovalInput(input);
      if (provenance !== null) {
        assertValidCreatorProvenance(provenance);
      }
      const chain = await resolveClientChain(input.clientId);
      const outcome = await store.insertCreatorApproval(
        {
          clientId: chain.clientId,
          agencyId: chain.agencyId,
          action: input.action,
          resourceId: input.resourceId,
          decision: input.decision,
          approverUserId: input.approverUserId,
          approverSpecializations: input.approverSpecializations,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
        },
        actorId,
      );
      return outcome.record;
    },

    async listCreatorApprovalsForResource(input) {
      return store.listCreatorApprovalsForResource(input.action, input.resourceId);
    },

    // ----- The observation mapping (CREATOR-AC-02) ------------------------------------

    async recordCreatorObservation(input, provenance): Promise<CreatorObservationReceipt> {
      assertValidCreatorObservationInput(input);
      assertValidCreatorProvenance(provenance);
      const chain = await resolveClientChain(input.clientId);

      // The evidence half: an immutable 'observation' record in the COMMON
      // /evidence ledger, appended THROUGH the port with server-derived
      // provenance. Source system 'creator-operations', content carrying
      // the pack's subject taxonomy.
      const evidence = await deps.evidence.appendEvidence(
        {
          clientId: chain.clientId,
          workspaceId: input.workspaceId,
          class: 'observation',
          source: { system: 'creator-operations', ref: input.subjectRef },
          observedAt: input.observedAt,
          content: {
            subjectKind: input.subjectKind,
            subjectRef: input.subjectRef,
            eventKind: input.eventKind,
            detail: input.content,
          },
          contentRef: null,
          quality: input.quality,
          confidence: null,
          supersedesEvidenceId: null,
        },
        provenance,
      );

      // The metric half (when a mapping is declared): the normalized
      // observation in the COMMON /metrics ledger, bound to the evidence
      // record through evidenceRef.
      if (input.metric === null) {
        return { evidenceId: evidence.evidenceId, observationId: null };
      }
      const metric = await deps.metrics.appendMetricObservation(
        {
          clientId: chain.clientId,
          workspaceId: input.workspaceId,
          metricName: input.metric.name,
          dimensions: input.metric.dimensions,
          value: input.metric.value,
          unit: input.metric.unit,
          source: { system: 'creator-operations', ref: input.subjectRef },
          observedAt: input.observedAt,
          retrievedAt: null,
          evidenceRef: evidence.evidenceId,
          quality: 'ok',
          aggregationMethod: input.metric.aggregationMethod,
        },
        provenance,
      );
      return { evidenceId: evidence.evidenceId, observationId: metric.observationId };
    },

    // ----- AI task declarations (CREATOR-AC-03) ----------------------------------------

    async provisionCreatorTaskProfiles(input): Promise<readonly CreatorTaskProfileProvisionReceipt[]> {
      assertValidCreatorTaskProfileProvisionInput(input);
      const receipts: CreatorTaskProfileProvisionReceipt[] = [];
      for (const declaration of CREATOR_TASK_PROFILE_DECLARATIONS) {
        // Every AI task class of the pack registers as a REAL TaskProfile
        // through the /ai-runtime authority's own creation surface —
        // pack AI tasks are consumed through the platform AI Router
        // (CREATOR-AC-03), never through provider-specific model calls.
        const receipt = await deps.aiRuntime.createTaskProfile({
          workspaceId: input.scope.workspaceId,
          clientId: input.scope.clientId,
          agencyId: input.scope.agencyId,
          profile: declaration,
          idempotencyKey: `${input.idempotencyKey}:${declaration.taskClass}`,
          actorId: input.actorId,
        });
        receipts.push({
          taskClass: declaration.taskClass,
          taskProfileId: receipt.taskProfile.taskProfileId,
          replayed: receipt.replayed,
        });
      }
      return receipts;
    },

    // ----- Pack publication ----------------------------------------------------------

    async publishCreatorOperationsPack(input) {
      return deps.domainPacks.publishDomainPackVersion({
        manifest: CREATOR_OPERATIONS_PACK_MANIFEST,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
      });
    },

    getCreatorOperationsManifest() {
      return CREATOR_OPERATIONS_PACK_MANIFEST;
    },
  };
}
