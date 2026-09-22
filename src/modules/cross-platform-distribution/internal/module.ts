/**
 * /cross-platform-distribution module implementation (MKT-065).
 *
 * THE DISTRIBUTION PLAN AUTHORITY — planning and recording rights/policy-
 * gated multi-destination distribution of a canonical source or derived
 * asset to multiple connected social accounts (§5). The fan-out executor
 * composes, in fan-out order and FAIL-CLOSED PER DESTINATION:
 *
 *   1. THE 063 RIGHTS GATE (contentRights.evaluatePublicationGate — the
 *      sole rights authority): called BEFORE any publication attempt;
 *      only `allow` permits an autonomous publish — review_required and
 *      blocked NEVER publish (the verdicts are recorded on the lineage
 *      tail WITH reasons; review_required is the
 *      blocked_pending_human_action surface). This module never
 *      re-evaluates rights.
 *   2. PER-PLATFORM CAPABILITY VALIDATION (socialAccounts.
 *      resolveAccountCapabilityMatrix + integrations.listRegisteredAdapters):
 *      the destination account's REAL capabilities — capability parity is
 *      never assumed (lock rule 19); a destination lacking the required
 *      publish capability is rejected and recorded, never attempted
 *      blind (lock rule 29).
 *   3. THE DISPATCH POLICY GATE (policies.evaluateAction — the network
 *      dimension, operation 'content.distribution.dispatch', resource the
 *      destination platform): only an explicit allow permits; the
 *      decision rides the policy engine's own append-only ledger and its
 *      id is recorded on the lineage tail (this module holds NO policy
 *      authority).
 *   4. THE PUBLICATION ATTEMPT (socialAccounts.submitPublish — the 056
 *      idempotency ledger): the ONLY physical publish path, with the
 *      derived deterministic idempotency key (cpd:<plan>:<destination>)
 *      and the destination-specific request frozen at planning. NO
 *      parallel HTTP client, NO second engine.
 *
 * The agency/client scope of every command is SERVER-DERIVED input
 * (resolved by the route layer from canonical ownership — never a request
 * field; /clients is not a frozen allowance of this module's row).
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { ContentRightsProvenance } from '../../content-rights/public.ts';
import { enforcementOutcome } from '../../policies/public.ts';
import type { PolicyDecisionProvenance } from '../../policies/public.ts';
import type {
  SocialAccountProvenance,
  SocialPublishRequest,
} from '../../social-accounts/public.ts';
import { assertValidSocialPublishRequest } from '../../social-accounts/public.ts';
import type {
  CrossPlatformDistributionModuleApi,
  CrossPlatformDistributionModuleDeps,
  CrossPlatformDistributionProvenance,
  DistributionCapabilityRejectionCode,
  DistributionCapabilityResolutionPayload,
  DistributionDestinationRecord,
  DistributionEventRecord,
  DistributionGateEvaluationPayload,
  DistributionPlanDetail,
  DistributionPlanRecord,
  DistributionPolicyEvaluationPayload,
  DistributionPublicationAttemptPayload,
} from '../public.ts';
import { derivePublishIdempotencyKey } from '../public.ts';
import {
  assertValidCreateDistributionPlanInput,
  assertValidCrossPlatformDistributionProvenance,
  assertValidDispatchInput,
  assertValidMeasurementReferenceInput,
  computeDistributionPlanInputDigest,
  destinationStatusOfPublishState,
} from './validation.ts';
import { CrossPlatformDistributionStore } from './store.ts';

/** The UUID guard shape (an opaque uuid — malformed ids are uniform 404s). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The dispatch policy operation label (the network-dimension action). */
const DISTRIBUTION_DISPATCH_POLICY_OPERATION = 'content.distribution.dispatch';

/** The bounded client plan-list read (the house store bound). */
const PLAN_LIST_BOUND = 200;

export function createCrossPlatformDistributionModule(
  deps: CrossPlatformDistributionModuleDeps,
): CrossPlatformDistributionModuleApi {
  const store = new CrossPlatformDistributionStore(deps.db, deps.clock, deps.ids);
  const { growthMissions, socialAccounts, contentAssets, contentRights, integrations, policies } =
    deps;
  const clock: Clock = deps.clock;

  // --- the provenance mappers (structural — the consumed contracts share
  // the house provenance shape; the mapping is explicit at this boundary) ---

  const asRightsProvenance = (
    provenance: CrossPlatformDistributionProvenance,
  ): ContentRightsProvenance => ({
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
  });

  const asSocialProvenance = (
    provenance: CrossPlatformDistributionProvenance,
  ): SocialAccountProvenance => ({
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
  });

  const asPolicyProvenance = (
    provenance: CrossPlatformDistributionProvenance,
  ): PolicyDecisionProvenance => ({
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
  });

  const asStoreProvenance = (provenance: CrossPlatformDistributionProvenance) => ({
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
  });

  // --- the canonical resolutions (uniform 404s — no cross-tenant oracle) ---

  /** The plan by id — uniform 404 on unknown/malformed. */
  async function requirePlan(planId: string): Promise<DistributionPlanRecord> {
    if (!UUID_PATTERN.test(planId)) {
      throw new NotFoundError('distribution_plan', planId);
    }
    const plan = await store.getPlan(planId);
    if (plan === null) {
      throw new NotFoundError('distribution_plan', planId);
    }
    return plan;
  }

  /**
   * ONE resolved versioned asset ref (the 064 discipline): the ref must
   * resolve to an EXPLICIT version record IN THIS CLIENT — unknown and
   * foreign are the SAME uniform NotFoundError (never a floating
   * pointer).
   */
  async function requireAssetVersionInClient(clientId: string, assetRef: string) {
    const version = await contentAssets.resolveAssetRef(clientId, assetRef);
    if (version === null) {
      throw new NotFoundError('content_asset_version', assetRef);
    }
    return version;
  }

  // --- the composed detail read ---------------------------------------------

  async function composeDetail(
    plan: DistributionPlanRecord,
  ): Promise<DistributionPlanDetail> {
    const [destinations, publications, events] = await Promise.all([
      store.listDestinationsOfPlan(plan.planId),
      store.listPublicationsOfPlan(plan.planId),
      store.listEventsOfPlan(plan.planId),
    ]);
    return { plan, destinations, publications, events };
  }

  // --- the fan-out steps (each returns the recorded payload + the
  // fail-closed verdict) ------------------------------------------------------

  /**
   * STEP 1 — THE 063 RIGHTS GATE (composed, never duplicated): the sole
   * rights authority evaluates the destination's asset against the
   * destination platform. Only `allow` permits; review_required and
   * blocked NEVER publish (fail-closed — the 063 boundary rule).
   */
  async function evaluateRightsGate(
    plan: DistributionPlanRecord,
    destination: DistributionDestinationRecord,
    provenance: CrossPlatformDistributionProvenance,
  ): Promise<DistributionGateEvaluationPayload> {
    const gate = await contentRights.evaluatePublicationGate(
      {
        agencyId: plan.agencyId,
        clientId: plan.clientId,
        assetRef: destination.assetRef,
        destinationPlatform: destination.platformId,
      },
      asRightsProvenance(provenance),
    );
    const payload: DistributionGateEvaluationPayload = {
      assetRef: gate.assetRef,
      destinationPlatform: gate.destinationPlatform,
      outcome: gate.outcome,
      reasons: gate.reasons.map((reason) => ({ code: reason.code, detail: reason.detail })),
      composite: gate.composite,
      policyDecisionId: gate.policyDecisionId,
      vocabularyVersion: gate.vocabularyVersion,
    };
    await store.appendEvent(
      {
        planId: plan.planId,
        clientId: plan.clientId,
        destinationId: destination.destinationId,
        eventKind: 'gate_evaluation',
        payload: { ...payload },
      },
      asStoreProvenance(provenance),
    );
    return payload;
  }

  /**
   * STEP 2 — PER-PLATFORM CAPABILITY VALIDATION (fail-closed, never
   * attempted blind): the destination account's REAL capabilities through
   * the /social-accounts capability matrix (the declared adapter
   * capability subset, the usable authorization, the per-family scope
   * satisfaction against the CURRENT grant's verbatim scopes) plus the
   * /integrations adapter registry (the 056 normalized adapter contract's
   * platform pipe). Capability parity is NEVER assumed (lock rule 19).
   */
  async function resolveDestinationCapability(
    destination: DistributionDestinationRecord,
  ): Promise<DistributionCapabilityResolutionPayload> {
    const matrix = await socialAccounts.resolveAccountCapabilityMatrix(
      destination.socialAccountId,
    );
    if (matrix === null) {
      throw new NotFoundError('social_account', destination.socialAccountId);
    }

    const rejectionCodes: DistributionCapabilityRejectionCode[] = [];
    if (!matrix.registered) {
      rejectionCodes.push('platform_adapter_unregistered');
    }
    if (!matrix.authorizationUsable) {
      rejectionCodes.push('authorization_unusable');
    }
    const publishCapability = matrix.capabilities.find(
      (capability) => capability.family === 'publish',
    );
    const publishCapabilityDeclared = publishCapability !== undefined;
    if (!publishCapabilityDeclared) {
      rejectionCodes.push('publish_capability_undeclared');
    }
    const publishOperationDeclared =
      publishCapabilityDeclared &&
      (publishCapability!.operations as readonly string[]).includes('submitPublish');
    if (publishCapabilityDeclared && !publishOperationDeclared) {
      rejectionCodes.push('publish_operation_undeclared');
    }
    const publishSatisfaction = matrix.scopeSatisfaction.find(
      (satisfaction) => satisfaction.family === 'publish',
    );
    const publishScopesSatisfied = publishSatisfaction?.satisfied ?? false;
    const missingScopes = publishSatisfaction?.missingScopes ?? [];
    if (publishOperationDeclared && !publishScopesSatisfied) {
      rejectionCodes.push('publish_scope_unsatisfied');
    }
    const integrationAdapterRegistered = integrations
      .listRegisteredAdapters()
      .some((adapter) => adapter.descriptor.adapterKey === destination.platformId);
    if (!integrationAdapterRegistered) {
      rejectionCodes.push('integration_adapter_unregistered');
    }

    return {
      platformId: destination.platformId,
      socialPlatformAdapterRegistered: matrix.registered,
      integrationAdapterRegistered,
      authorizationUsable: matrix.authorizationUsable,
      publishCapabilityDeclared,
      publishOperationDeclared,
      publishScopesSatisfied,
      missingScopes: [...missingScopes],
      allowed: rejectionCodes.length === 0,
      rejectionCodes,
    };
  }

  /**
   * STEP 3 — THE DISPATCH POLICY GATE (/policies, fail-closed): the
   * network-dimension action 'content.distribution.dispatch' (resource =
   * the destination platform) — only an explicit allow permits; deny and
   * unknown both BLOCK. The decision rides the policy engine's own
   * append-only ledger; this module records the decision id.
   */
  async function evaluateDispatchPolicy(
    plan: DistributionPlanRecord,
    destination: DistributionDestinationRecord,
    provenance: CrossPlatformDistributionProvenance,
  ): Promise<DistributionPolicyEvaluationPayload> {
    const decision = await policies.evaluateAction(
      {
        action: {
          dimension: 'network',
          operation: DISTRIBUTION_DISPATCH_POLICY_OPERATION,
          resource: destination.platformId,
          attributes: {
            planId: plan.planId,
            destinationId: destination.destinationId,
            socialOperation: 'submitPublish',
          },
        },
        scope: { agencyId: plan.agencyId, clientId: plan.clientId },
      },
      asPolicyProvenance(provenance),
    );
    const payload: DistributionPolicyEvaluationPayload = {
      platformId: destination.platformId,
      decisionId: decision.decisionId,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      reasons: [...decision.reasons],
    };
    await store.appendEvent(
      {
        planId: plan.planId,
        clientId: plan.clientId,
        destinationId: destination.destinationId,
        eventKind: 'policy_evaluation',
        payload: { ...payload },
      },
      asStoreProvenance(provenance),
    );
    return payload;
  }

  /**
   * STEP 4 — THE PUBLICATION ATTEMPT (the 056 submitPublish contract, the
   * ONLY physical publish path): the derived deterministic idempotency
   * key + the destination-specific request. The outcome is the 056
   * ledger's own record (the attempt id, the publish state, the provider
   * refs, the duplicate flag) — recorded verbatim on the lineage tail and
   * linked through the per-destination publication row.
   */
  async function attemptDestinationPublication(
    plan: DistributionPlanRecord,
    destination: DistributionDestinationRecord,
    provenance: CrossPlatformDistributionProvenance,
  ): Promise<DistributionPublicationAttemptPayload> {
    const submit = await socialAccounts.submitPublish(
      destination.socialAccountId,
      {
        idempotencyKey: destination.idempotencyKey,
        request: destination.publishRequest,
      },
      asSocialProvenance(provenance),
    );
    const attempt = submit.attempt;
    const payload: DistributionPublicationAttemptPayload = {
      publishAttemptId: attempt.attemptId,
      idempotencyKey: destination.idempotencyKey,
      duplicate: submit.duplicate,
      publishState: attempt.publishState,
      failureCode: attempt.failureCode,
      providerPublishId: attempt.providerPublishId,
      providerContentId: attempt.providerContentId,
      publishedAt: attempt.publishedAt,
    };
    // The publication link row + the destination outcome move + the
    // lineage event — the submit-time facts in one durable step.
    await store.insertPublication(
      {
        planId: plan.planId,
        destinationId: destination.destinationId,
        clientId: plan.clientId,
        socialAccountId: destination.socialAccountId,
        publishAttemptId: attempt.attemptId,
        idempotencyKey: destination.idempotencyKey,
        publishState: attempt.publishState,
        failureCode: attempt.failureCode,
        providerPublishId: attempt.providerPublishId,
        providerContentId: attempt.providerContentId,
        publishedAt: attempt.publishedAt,
        duplicate: submit.duplicate,
      },
      asStoreProvenance(provenance),
    );
    await store.moveDestinationStatus(
      destination.destinationId,
      destinationStatusOfPublishState(attempt.publishState),
    );
    await store.appendEvent(
      {
        planId: plan.planId,
        clientId: plan.clientId,
        destinationId: destination.destinationId,
        eventKind: 'publication_attempt',
        payload: { ...payload },
      },
      asStoreProvenance(provenance),
    );
    return payload;
  }

  // -------------------------------------------------------------------------
  // createDistributionPlan — THE PLANNING (§5)
  // -------------------------------------------------------------------------

  async function createDistributionPlan(
    input: Parameters<CrossPlatformDistributionModuleApi['createDistributionPlan']>[0],
    provenance: CrossPlatformDistributionProvenance,
  ): Promise<DistributionPlanDetail> {
    // Provenance is server-derived and must be complete BEFORE anything
    // else runs — an incomplete provenance fails closed.
    assertValidCrossPlatformDistributionProvenance(provenance);
    // The frozen input shapes at the authority boundary (fail-closed by
    // rejection BEFORE any resolution or write).
    assertValidCreateDistributionPlanInput(input);

    // THE MISSION ANCHOR (read-only): the mission must resolve and belong
    // to the same agency as the (server-derived) plan scope — the mission
    // authority stays sole for mission identity/lifecycle; this module
    // NEVER mutates a mission.
    if (input.missionId !== null) {
      const missionOwnership = await growthMissions.resolveGrowthMissionOwnership(input.missionId);
      if (missionOwnership === null || missionOwnership.scope.agencyId !== input.agencyId) {
        throw new NotFoundError('growth_mission', input.missionId);
      }
    }

    // THE SOURCE ASSET (the 064 discipline): the opaque 'ca:' ref must
    // resolve to its EXPLICIT version record in this client — never a
    // floating pointer.
    const sourceVersion = await requireAssetVersionInClient(input.clientId, input.sourceAssetRef);

    // THE TRANSFORMATION PLAN: every declared output resolves the same
    // way (versioned derived outputs).
    const resolvedOutputs = new Map<string, string>();
    for (const output of input.transformationPlan.outputs) {
      const version = await requireAssetVersionInClient(input.clientId, output.assetRef);
      resolvedOutputs.set(output.assetRef, version.versionId);
    }

    // THE DESTINATION VARIANTS: every destination account resolves through
    // the /social-accounts canonical ownership (must belong to the SAME
    // client — uniform 404 otherwise; the platform id is FROZEN from the
    // account record, never caller-supplied), every published ref is the
    // source or one of the declared outputs (the §5 chain closure), and
    // the destination-specific 056 request (with the media assets derived
    // from the resolved version record) passes the 056 shape guard.
    const declaredRefs = new Set([input.sourceAssetRef, ...resolvedOutputs.keys()]);
    interface PreparedDestination {
      readonly socialAccountId: string;
      readonly platformId: string;
      readonly assetRef: string;
      readonly assetVersionId: string;
      readonly targetFormat: string;
      readonly publishRequest: SocialPublishRequest;
    }
    const prepared: PreparedDestination[] = [];
    for (const declaration of input.destinations) {
      if (!declaredRefs.has(declaration.assetRef)) {
        throw new ConflictError(
          `destination asset ref '${declaration.assetRef}' is neither the plan source nor a declared transformation output (the §5 chain: Source Asset → Transformation Plan → Target Platform/Account/Format)`,
        );
      }
      const accountOwnership = await socialAccounts.resolveAccountOwnership(
        declaration.socialAccountId,
      );
      if (accountOwnership === null || accountOwnership.account.clientId !== input.clientId) {
        throw new NotFoundError('social_account', declaration.socialAccountId);
      }
      const assetVersion = declaration.assetRef === input.sourceAssetRef
        ? sourceVersion
        : await requireAssetVersionInClient(input.clientId, declaration.assetRef);
      const publishRequest: SocialPublishRequest = {
        contentType: declaration.publishRequest.contentType,
        payload: { ...declaration.publishRequest.payload },
        mediaAssets: [
          {
            assetReference: assetVersion.assetRef,
            mediaKind: assetVersion.mediaKind,
            // The bounded non-secret descriptor (the §21 backstop of the
            // 056 shape guard rejects material-shaped values — a raw hex
            // object digest matches the material-value hint, so the
            // content-addressed digest stays in the version record, never
            // in the passthrough descriptor).
            descriptor: {
              displayName: assetVersion.displayName,
              contentType: assetVersion.contentType,
              version: assetVersion.version,
            },
          },
        ],
        attribution: { ...declaration.publishRequest.attribution },
        scheduledFor: declaration.publishRequest.scheduledFor,
      };
      // The 056 shape guard at planning time (fail-closed by rejection —
      // a request the ledger would refuse never becomes a plan).
      assertValidSocialPublishRequest(publishRequest);
      prepared.push({
        socialAccountId: declaration.socialAccountId,
        platformId: accountOwnership.account.platformId,
        assetRef: declaration.assetRef,
        assetVersionId: assetVersion.versionId,
        targetFormat: declaration.targetFormat,
        publishRequest,
      });
    }

    const inputDigest = computeDistributionPlanInputDigest({
      sourceAssetRef: input.sourceAssetRef,
      transformationPlan: input.transformationPlan,
      destinations: input.destinations,
    });

    // THE DURABLE WRITE (one transaction): the plan (born 'planned'), the
    // destination variants (born 'planned', the derived idempotency keys)
    // and the plan_created lineage event — atomic, all-or-nothing. The
    // plan id is minted ONCE (the store's insert returns the persisted
    // row; every dependent row and the lineage event anchor on the
    // RETURNED id — the actual durable identity).
    let plan: DistributionPlanRecord | null = null;
    const destinationRecords: DistributionDestinationRecord[] = [];
    await deps.db.transaction(async (tx) => {
      plan = await store.insertPlanTx(
        tx,
        {
          agencyId: input.agencyId,
          clientId: input.clientId,
          workspaceId: input.workspaceId,
          missionId: input.missionId,
          sourceAssetRef: input.sourceAssetRef,
          sourceVersionId: sourceVersion.versionId,
          transformationPlan: input.transformationPlan,
          inputDigest,
        },
        asStoreProvenance(provenance),
      );
      const createdPlanId = plan!.planId;
      for (const [index, destination] of prepared.entries()) {
        const destinationId = deps.ids.newId();
        const record = await store.insertDestinationTx(
          tx,
          {
            destinationId,
            planId: createdPlanId,
            clientId: input.clientId,
            position: index + 1,
            socialAccountId: destination.socialAccountId,
            platformId: destination.platformId,
            assetRef: destination.assetRef,
            assetVersionId: destination.assetVersionId,
            targetFormat: destination.targetFormat,
            publishRequest: destination.publishRequest,
            idempotencyKey: derivePublishIdempotencyKey(createdPlanId, destinationId),
          },
          asStoreProvenance(provenance),
        );
        destinationRecords.push(record);
      }
      await store.appendEventTx(
        tx,
        {
          planId: createdPlanId,
          clientId: input.clientId,
          destinationId: null,
          eventKind: 'plan_created',
          payload: {
            sourceAssetRef: input.sourceAssetRef,
            sourceVersionId: sourceVersion.versionId,
            missionId: input.missionId,
            transformationPlan: {
              description: input.transformationPlan.description,
              outputs: input.transformationPlan.outputs.map((output) => ({
                assetRef: output.assetRef,
                variantLabel: output.variantLabel,
              })),
            },
            destinations: destinationRecords.map((record) => ({
              destinationId: record.destinationId,
              position: record.position,
              socialAccountId: record.socialAccountId,
              platformId: record.platformId,
              assetRef: record.assetRef,
              targetFormat: record.targetFormat,
              idempotencyKey: record.idempotencyKey,
            })),
            inputDigest,
            vocabularyVersion: 'cpd-vocab-v1',
          },
        },
        asStoreProvenance(provenance),
      );
    });

    // The plan ids are minted server-side before the inserts; re-read the
    // composed detail for the honest read-back.
    const created = plan!;
    return composeDetail(created);
  }

  // -------------------------------------------------------------------------
  // dispatchDistributionPlan — THE FAN-OUT EXECUTION (the AC)
  // -------------------------------------------------------------------------

  async function dispatchDistributionPlan(
    input: Parameters<CrossPlatformDistributionModuleApi['dispatchDistributionPlan']>[0],
    provenance: CrossPlatformDistributionProvenance,
  ): Promise<DistributionPlanDetail> {
    assertValidCrossPlatformDistributionProvenance(provenance);
    assertValidDispatchInput(input);

    const plan = await requirePlan(input.planId);

    // THE PLAN LIFECYCLE: planned|dispatched → dispatching (CAS; a
    // 'dispatching' plan is an interrupted dispatch — the re-dispatch
    // resumes it honestly, never a second concurrent execution).
    if (plan.planState !== 'dispatching') {
      await store.movePlanState(plan.planId, 'dispatching');
    }
    await store.appendEvent(
      {
        planId: plan.planId,
        clientId: plan.clientId,
        destinationId: null,
        eventKind: 'dispatch_started',
        payload: {
          destinations: (await store.listDestinationsOfPlan(plan.planId)).map((destination) => ({
            destinationId: destination.destinationId,
            destinationStatus: destination.destinationStatus,
          })),
          vocabularyVersion: 'cpd-vocab-v1',
        },
      },
      asStoreProvenance(provenance),
    );

    // THE FAN-OUT: fail-closed per destination, in fan-out order — one
    // destination's outcome NEVER blocks the others.
    const destinations = await store.listDestinationsOfPlan(plan.planId);
    const outcomeSummary: { destinationId: string; destinationStatus: string }[] = [];
    for (const destination of destinations) {
      // The idempotent re-dispatch convergence: a destination with a
      // recorded publication replays from the 056 fence (duplicate: true,
      // ZERO provider traffic) — the recorded outcome stands (a same-key
      // retry never becomes a different operation; a fresh publication is
      // a NEW plan).
      const existingPublication = await store.getPublicationForDestination(
        destination.destinationId,
      );
      if (existingPublication !== null) {
        await attemptDestinationPublication(plan, destination, provenance);
        outcomeSummary.push({
          destinationId: destination.destinationId,
          destinationStatus: destinationStatusOfPublishState(existingPublication.publishState),
        });
        continue;
      }

      // STEP 1 — THE 063 RIGHTS GATE (fail-closed: only allow proceeds).
      const gate = await evaluateRightsGate(plan, destination, provenance);
      if (gate.outcome === 'review_required') {
        await store.moveDestinationStatus(destination.destinationId, 'rights_review_required');
        outcomeSummary.push({
          destinationId: destination.destinationId,
          destinationStatus: 'rights_review_required',
        });
        continue;
      }
      if (gate.outcome === 'blocked') {
        await store.moveDestinationStatus(destination.destinationId, 'rights_blocked');
        outcomeSummary.push({
          destinationId: destination.destinationId,
          destinationStatus: 'rights_blocked',
        });
        continue;
      }

      // STEP 2 — PER-PLATFORM CAPABILITY VALIDATION (never attempted
      // blind).
      const capability = await resolveDestinationCapability(destination);
      await store.appendEvent(
        {
          planId: plan.planId,
          clientId: plan.clientId,
          destinationId: destination.destinationId,
          eventKind: 'capability_resolution',
          payload: { ...capability },
        },
        asStoreProvenance(provenance),
      );
      if (!capability.allowed) {
        await store.moveDestinationStatus(destination.destinationId, 'capability_rejected');
        outcomeSummary.push({
          destinationId: destination.destinationId,
          destinationStatus: 'capability_rejected',
        });
        continue;
      }

      // STEP 3 — THE DISPATCH POLICY GATE (fail-closed).
      const policy = await evaluateDispatchPolicy(plan, destination, provenance);
      if (enforcementOutcome({ outcome: policy.outcome }) !== 'allow') {
        await store.moveDestinationStatus(destination.destinationId, 'policy_blocked');
        outcomeSummary.push({
          destinationId: destination.destinationId,
          destinationStatus: 'policy_blocked',
        });
        continue;
      }

      // STEP 4 — THE PUBLICATION ATTEMPT (the 056 contract).
      const attempt = await attemptDestinationPublication(plan, destination, provenance);
      outcomeSummary.push({
        destinationId: destination.destinationId,
        destinationStatus: destinationStatusOfPublishState(attempt.publishState),
      });
    }

    // THE DISPATCH COMPLETION: the summary event + the plan lifecycle
    // move (dispatching → dispatched, CAS).
    await store.appendEvent(
      {
        planId: plan.planId,
        clientId: plan.clientId,
        destinationId: null,
        eventKind: 'dispatch_completed',
        payload: {
          outcomes: outcomeSummary,
          vocabularyVersion: 'cpd-vocab-v1',
        },
      },
      asStoreProvenance(provenance),
    );
    const dispatched = await store.movePlanState(plan.planId, 'dispatched');
    return composeDetail(dispatched);
  }

  // -------------------------------------------------------------------------
  // The reads + the measurement tail
  // -------------------------------------------------------------------------

  async function getDistributionPlan(planId: string): Promise<DistributionPlanRecord | null> {
    if (!UUID_PATTERN.test(planId)) return null;
    return store.getPlan(planId);
  }

  async function resolveDistributionPlanOwnership(planId: string) {
    if (!UUID_PATTERN.test(planId)) return null;
    const plan = await store.getPlan(planId);
    if (plan === null) return null;
    return {
      scope: {
        kind: 'distribution_plan' as const,
        agencyId: plan.agencyId,
        clientId: plan.clientId,
        workspaceId: plan.workspaceId,
        planId: plan.planId,
      },
      plan,
      resolvedAt: clock.nowIso(),
    };
  }

  async function listDistributionPlansForClient(clientId: string) {
    return store.listPlansForClient(clientId, PLAN_LIST_BOUND);
  }

  async function getDistributionPlanDetail(planId: string): Promise<DistributionPlanDetail | null> {
    if (!UUID_PATTERN.test(planId)) return null;
    const plan = await store.getPlan(planId);
    if (plan === null) return null;
    return composeDetail(plan);
  }

  async function recordMeasurementReference(
    input: Parameters<CrossPlatformDistributionModuleApi['recordMeasurementReference']>[0],
    provenance: CrossPlatformDistributionProvenance,
  ): Promise<DistributionEventRecord> {
    assertValidCrossPlatformDistributionProvenance(provenance);
    assertValidMeasurementReferenceInput(input);
    const plan = await requirePlan(input.planId);
    if (input.destinationId !== null) {
      const destination = await store.getDestination(input.destinationId);
      if (destination === null || destination.planId !== plan.planId) {
        throw new NotFoundError('distribution_destination', input.destinationId);
      }
    }
    return store.appendEvent(
      {
        planId: plan.planId,
        clientId: plan.clientId,
        destinationId: input.destinationId,
        eventKind: 'measurement_reference',
        payload: {
          measurementRef: input.measurementRef,
          note: input.note,
        },
      },
      asStoreProvenance(provenance),
    );
  }

  return {
    createDistributionPlan,
    dispatchDistributionPlan,
    getDistributionPlan,
    resolveDistributionPlanOwnership,
    listDistributionPlansForClient,
    getDistributionPlanDetail,
    recordMeasurementReference,
  };
}

export type { CrossPlatformDistributionModuleDeps };
