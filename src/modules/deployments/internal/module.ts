/**
 * /deployments module implementation (MKT-040, DEPLOY-002 — the Marketing
 * Cloud Deployment control plane).
 *
 * Thin orchestration over the store + the STRUCTURAL PORTS (the frozen
 * dependency matrix grants /deployments no direct module imports — every
 * consumed public contract arrives as a narrow typed port wired at the
 * composition root, the /integrations MKT-023 precedent extended to the
 * whole dependency surface). The fail-closed chain on every material
 * operation:
 *
 *   canonical /workspaces ownership resolution BEFORE any read/write →
 *   EXPLICIT immutable version reference resolution through /playbooks +
 *   /workflows → the full resolution contract (the pure evaluator over
 *   port snapshots: authorization, playbook version, workflow versions,
 *   domain packs, capabilities, credential references, policy, runtime,
 *   triggers) → the /policies fail-closed deployment-dimension gate
 *   (only an explicit recorded 'allow' proceeds) → the CAS transition +
 *   the append-only ledger event.
 *
 * THE AUTHORITY BOUNDARY (marketing-cloud-deployment-v1.4.md): this
 * module owns deployment intent, dependency resolution, activation state
 * and deployment history — NOTHING else. The only sanctioned interaction
 * with the execution authority is createExecution through the request
 * port (requesting execution, never executing or orchestrating); there
 * is no dispatch, no retry classification, no queue consumption, no
 * workflow-instance surface and no sandbox/lease surface anywhere here
 * (DEPLOY-AC-07 — asserted by the static architecture tests).
 *
 * Fail-closed contract:
 *   - unknown workspace / unknown deployment / foreign identifiers →
 *     uniform NotFoundError (no existence or traversal oracle —
 *     DEPLOY-AC-08);
 *   - disabled boundaries → ConflictError (new use blocked, history
 *     never rewritten);
 *   - a failing resolution check → InvalidRequestError carrying EVERY
 *     failed check BEFORE any state change (DEPLOY-AC-04: no partially
 *     validated deployment becomes READY or ACTIVE);
 *   - a policy deny/unknown → PolicyDeniedError BEFORE the transition
 *     (POL-001 posture, the /integrations precedent);
 *   - an illegal lifecycle edge → ConflictError (DEPLOY-AC-05; the DB
 *     trigger is the backstop).
 */

import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PolicyDeniedError,
} from '../../../platform/errors/errors.ts';
import type {
  DeploymentEventType,
  DeploymentProvenance,
  DeploymentRecord,
  DeploymentSelection,
  DeploymentStatus,
  DeploymentTransitionOutcome,
  DeploymentValidationReport,
  DeploymentsModuleApi,
  DeploymentsModuleDeps,
  DeploymentsOwnerContext,
  DeploymentsWorkflowDefinitionSnapshot,
  DeploymentsWorkflowSnapshot,
} from '../public.ts';
import {
  evaluateDeploymentResolution,
  assertValidDeploymentCreation,
  assertValidProvenance,
  assertValidTransitionRequest,
  type DeploymentResolutionSnapshots,
} from './resolution.ts';
import {
  DeploymentsStore,
  composeDeploymentOwnerContext,
} from './store.ts';

export function createDeploymentsModule(deps: DeploymentsModuleDeps): DeploymentsModuleApi {
  const store = new DeploymentsStore(deps.db, deps.clock, deps.ids);
  const { workspaceOwnership, playbooks, workflows, domainPacks, extensions, integrations, policies, credentials, executions, clock } = deps;

  // -------------------------------------------------------------------------
  // Canonical ownership resolution (implementation-contract §2)
  // -------------------------------------------------------------------------

  /**
   * Canonical Workspace ownership resolution from durable state BEFORE
   * any dependent traversal: null → uniform 404 (unknown/tombstoned/
   * foreign Workspace — indistinguishable); disabled boundary → 409
   * blocks new use without rewriting history.
   */
  async function requireWorkspaceForWrite(workspaceId: string) {
    const ownership = await workspaceOwnership.resolveWorkspaceOwnership(workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    if (ownership.workspace.status !== 'active') {
      throw new ConflictError(
        `workspace ${workspaceId} is ${ownership.workspace.status}; new deployment writes are blocked`,
      );
    }
    if (ownership.client.status !== 'active') {
      throw new ConflictError(
        `client ${ownership.client.clientId} is ${ownership.client.status}; new deployment writes are blocked`,
      );
    }
    if (ownership.clientOwnership.agency.status !== 'active') {
      throw new ConflictError(
        `agency ${ownership.clientOwnership.agency.agencyId} is ${ownership.clientOwnership.agency.status}; new deployment writes are blocked`,
      );
    }
    return ownership;
  }

  /**
   * The deployment-scoped ownership resolution: the row + its canonical
   * Workspace/Client/Agency chain. Null when the deployment does not
   * exist OR its chain no longer resolves — callers surface a uniform
   * 404 (the hard-boundary posture, DEPLOY-AC-08).
   */
  async function requireOwnership(deploymentId: string): Promise<DeploymentsOwnerContext> {
    const deployment = await store.getDeployment(deploymentId);
    if (deployment === null) {
      throw new NotFoundError('deployment', deploymentId);
    }
    const ownership = await workspaceOwnership.resolveWorkspaceOwnership(deployment.workspaceId);
    if (ownership === null) {
      throw new NotFoundError('deployment', deploymentId);
    }
    if (ownership.scope.agencyId !== deployment.agencyId) {
      throw new NotFoundError('deployment', deploymentId);
    }
    return composeDeploymentOwnerContext(deployment, ownership, clock.nowIso());
  }

  // -------------------------------------------------------------------------
  // The immutable-version reference fences (creation + redeploy requests)
  // -------------------------------------------------------------------------

  /**
   * The pinned playbook version fence: the version must resolve through
   * /playbooks as PUBLISHED (immutable approved versions only — draft/
   * review are still editable; retired are withdrawn) and its playbook
   * must be usable inside the target Client (Agency-scoped reusable:
   * same Agency; Client-scoped: same Client). A foreign version is the
   * SAME uniform 404 as an unknown one (no cross-tenant oracle).
   */
  async function requirePublishedPlaybookVersion(
    selection: DeploymentSelection,
    scope: { agencyId: string; clientId: string; workspaceId: string },
  ): Promise<void> {
    const playbookVersion = await playbooks.getPlaybookVersion(selection.playbookVersionId);
    if (playbookVersion === null) {
      throw new NotFoundError('playbook version', selection.playbookVersionId);
    }
    if (playbookVersion.status !== 'published') {
      throw new ConflictError(
        `playbook version ${selection.playbookVersionId} is ${playbookVersion.status}; deployments pin published (immutable approved) versions only`,
      );
    }
    const playbook = await playbooks.getPlaybook(playbookVersion.playbookId);
    if (playbook === null) {
      throw new NotFoundError('playbook version', selection.playbookVersionId);
    }
    if (playbook.agencyId !== scope.agencyId) {
      throw new NotFoundError('playbook version', selection.playbookVersionId);
    }
    if (playbook.clientId !== null && playbook.clientId !== scope.clientId) {
      throw new NotFoundError('playbook version', selection.playbookVersionId);
    }
    for (const definitionId of selection.workflowDefinitionIds) {
      const definition = await workflows.getWorkflowDefinition(definitionId);
      if (definition === null) {
        throw new NotFoundError('workflow definition', definitionId);
      }
      // The workspace-ownership fence runs BEFORE the status checks: a
      // definition of ANOTHER workspace is the SAME uniform 404 as an
      // unknown one (DEPLOY-AC-08 — no cross-tenant oracle).
      const workflow = await workflows.getWorkflow(definition.workflowId);
      if (workflow === null || workflow.workspaceId !== scope.workspaceId) {
        throw new NotFoundError('workflow definition', definitionId);
      }
      if (definition.status !== 'active') {
        throw new ConflictError(
          `workflow definition ${definitionId} is ${definition.status}; deployments pin active (immutable) definition versions only`,
        );
      }
      if (definition.playbookVersionId !== selection.playbookVersionId) {
        throw new ConflictError(
          `workflow definition ${definitionId} does not pin playbook version ${selection.playbookVersionId} (immutable-version compatibility)`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // The fail-closed policy gate (the deployment dimension)
  // -------------------------------------------------------------------------

  /**
   * The /policies fail-closed evaluation: ONLY an explicit 'allow'
   * proceeds (deny/unknown → PolicyDeniedError BEFORE any transition).
   * The frozen deployment-dimension operation vocabulary:
   * deploy/pause/resume/redeploy/rollback.
   */
  async function requirePolicyAllow(
    operation: 'deployment.deploy' | 'deployment.pause' | 'deployment.resume' | 'deployment.redeploy' | 'deployment.rollback',
    scope: { agencyId: string; clientId: string },
    provenance: DeploymentProvenance,
  ): Promise<{ readonly decisionId: string; readonly outcome: string }> {
    const decision = await policies.evaluateAction(
      {
        action: {
          dimension: 'deployment',
          operation,
          resource: null,
          attributes: {},
        },
        scope,
      },
      {
        actor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
      },
    );
    if (decision.outcome !== 'allow') {
      throw new PolicyDeniedError(
        `deployment action '${operation}' denied by policy (decision ${decision.decisionId}: ${decision.outcome}/${decision.reasonCode} — explicit allow required)`,
      );
    }
    return { decisionId: decision.decisionId, outcome: decision.outcome };
  }

  // -------------------------------------------------------------------------
  // The resolution snapshot gathering (the port reads for the evaluator)
  // -------------------------------------------------------------------------

  /**
   * Gathers EVERY port snapshot the pure evaluator consumes for one
   * (scope, selection) pair — plus the pre-consulted policy decision for
   * the gated operation. The module reads; the evaluator judges.
   */
  async function gatherResolutionSnapshots(
    scope: { agencyId: string; clientId: string; workspaceId: string },
    selection: DeploymentSelection,
    policyOperation: 'deployment.deploy' | 'deployment.resume' | 'deployment.redeploy' | 'deployment.rollback',
    provenance: DeploymentProvenance,
  ): Promise<DeploymentResolutionSnapshots> {
    // The fail-closed policy evaluation FIRST (a deny never needs the
    // remaining reads; the decision id rides into the report).
    const policyDecision = await requirePolicyAllow(policyOperation, scope, provenance);

    const ownership = await workspaceOwnership.resolveWorkspaceOwnership(scope.workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', scope.workspaceId);
    }

    const playbookVersion = await playbooks.getPlaybookVersion(selection.playbookVersionId);
    const playbook =
      playbookVersion === null ? null : await playbooks.getPlaybook(playbookVersion.playbookId);

    const workflowDefinitions: Array<{
      readonly definition: DeploymentsWorkflowDefinitionSnapshot | null;
      readonly workflow: DeploymentsWorkflowSnapshot | null;
    }> = [];
    for (const definitionId of selection.workflowDefinitionIds) {
      const definition = await workflows.getWorkflowDefinition(definitionId);
      const workflow = definition === null ? null : await workflows.getWorkflow(definition.workflowId);
      workflowDefinitions.push({ definition, workflow });
    }

    const packInstalls = await domainPacks.listDomainPackInstalls(scope.workspaceId);
    const packVersions = new Map<string, { packId: string; packKey: string; version: string }>();
    for (const install of packInstalls) {
      if (packVersions.has(install.packId)) continue;
      const packVersion = await domainPacks.getDomainPackVersion(install.packId);
      if (packVersion !== null) {
        packVersions.set(install.packId, packVersion);
      }
    }

    const extensionInstalls = await extensions.listExtensionInstalls(scope.workspaceId);
    const extensionVersions = new Map<string, { extensionId: string; extensionKey: string; version: string }>();
    for (const install of extensionInstalls) {
      if (extensionVersions.has(install.extensionId)) continue;
      const extensionVersion = await extensions.getExtensionVersion(install.extensionId);
      if (extensionVersion !== null) {
        extensionVersions.set(install.extensionId, extensionVersion);
      }
    }

    const adapters = integrations.listRegisteredAdapters();
    const connections = await integrations.listConnectionsForClient(scope.clientId);

    // Credential references: every reference bound by ANY extension
    // install (secret bindings) or carried by ANY connection of the
    // Client — the evaluator narrows to the satisfying ones.
    const credentialIds = new Set<string>();
    for (const install of extensionInstalls) {
      for (const referenceId of Object.values(install.secretBindings)) {
        credentialIds.add(referenceId);
      }
    }
    for (const connection of connections) {
      credentialIds.add(connection.credentialReferenceId);
    }
    const credentialsMap = new Map<
      string,
      { credentialId: string; agencyId: string; clientId: string | null; status: string }
    >();
    for (const credentialId of credentialIds) {
      const reference = await credentials.getCredentialReference(credentialId);
      if (reference !== null) {
        credentialsMap.set(credentialId, reference);
      }
    }

    return {
      workspaceOwnership: ownership,
      playbookVersion,
      playbook,
      workflowDefinitions,
      packInstalls,
      packVersions,
      extensionInstalls,
      extensionVersions,
      adapters,
      connections,
      credentials: credentialsMap,
      policyDecision,
    };
  }

  /**
   * The FULL GATE: snapshots + the pure evaluator + fail-closed
   * composition — ANY failed check → InvalidRequestError carrying every
   * failed check detail (DEPLOY-AC-04's module-side enforcement: the
   * transition NEVER happens with a red report).
   */
  async function runFullGate(
    scope: { agencyId: string; clientId: string; workspaceId: string },
    selection: DeploymentSelection,
    policyOperation: 'deployment.deploy' | 'deployment.resume' | 'deployment.redeploy' | 'deployment.rollback',
    provenance: DeploymentProvenance,
  ): Promise<DeploymentValidationReport> {
    const snapshots = await gatherResolutionSnapshots(scope, selection, policyOperation, provenance);
    const report = evaluateDeploymentResolution({ scope, selection }, snapshots);
    if (!report.ok) {
      const failed = report.checks.filter((check) => !check.ok).map((check) => `${check.check}: ${check.detail}`);
      throw new InvalidRequestError('Deployment validation failed (no state changed)', failed);
    }
    return report;
  }

  // -------------------------------------------------------------------------
  // Replay convergence (the §8-style idempotency fence)
  // -------------------------------------------------------------------------

  /**
   * Replay convergence for one logical command key: a recorded event
   * with the SAME target state converges (the caller re-reads the
   * CURRENT deployment); a key recorded with a DIFFERENT target is a
   * ConflictError — a key identifies one logical command.
   */
  async function findReplay(
    deploymentId: string,
    idempotencyKey: string,
    to: DeploymentStatus,
  ): Promise<DeploymentTransitionOutcome | null> {
    const recorded = await store.findEventByIdempotencyKey(deploymentId, idempotencyKey);
    if (recorded === null) return null;
    if (recorded.toStatus !== to) {
      throw new ConflictError(
        `idempotency key '${idempotencyKey}' was recorded for target '${recorded.toStatus}' (event ${recorded.eventId}); a key identifies one logical command`,
      );
    }
    const current = await store.getDeployment(deploymentId);
    if (current === null) {
      throw new NotFoundError('deployment', deploymentId);
    }
    return { deployment: current, event: recorded, replayed: true };
  }

  /** The recorded event by id for transition outcomes. */
  async function eventById(deploymentId: string, eventId: string) {
    const event = await store.getDeploymentEvent(deploymentId, eventId);
    if (event === null) {
      throw new Error(`recorded deployment event ${eventId} could not be read back`);
    }
    return event;
  }

  /** The current selection of a deployment as a snapshot value. */
  function currentSelection(deployment: DeploymentRecord): DeploymentSelection {
    return {
      playbookVersionId: deployment.playbookVersionId,
      workflowDefinitionIds: deployment.workflowDefinitionIds,
      requiredDomainPacks: deployment.requiredDomainPacks,
      requiredCapabilities: deployment.requiredCapabilities,
      runtimeRequirements: deployment.runtimeRequirements,
      triggerConfig: deployment.triggerConfig,
    };
  }

  // -------------------------------------------------------------------------
  // The module API
  // -------------------------------------------------------------------------

  return {
    async createDeployment(input, provenance) {
      assertValidProvenance(provenance);
      assertValidDeploymentCreation(input);
      const ownership = await requireWorkspaceForWrite(input.workspaceId);
      const scope = {
        agencyId: ownership.scope.agencyId,
        clientId: ownership.scope.clientId,
        workspaceId: ownership.scope.workspaceId,
      };
      await requirePublishedPlaybookVersion(input.selection, scope);
      const policyReferenceId = await resolvePolicyReferenceId(scope);
      return store.insertDeployment(
        {
          agencyId: scope.agencyId,
          clientId: scope.clientId,
          workspaceId: scope.workspaceId,
          selection: input.selection,
          policyReferenceId,
          createdBy: null,
        },
        provenance,
      );
    },

    async getDeployment(deploymentId) {
      return store.getDeployment(deploymentId);
    },

    async resolveDeploymentOwnership(deploymentId) {
      const deployment = await store.getDeployment(deploymentId);
      if (deployment === null) return null;
      const ownership = await workspaceOwnership.resolveWorkspaceOwnership(deployment.workspaceId);
      if (ownership === null) return null;
      if (ownership.scope.agencyId !== deployment.agencyId) return null;
      return composeDeploymentOwnerContext(deployment, ownership, clock.nowIso());
    },

    async listDeploymentsForWorkspace(workspaceId) {
      const ownership = await workspaceOwnership.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', workspaceId);
      }
      return store.listDeploymentsForWorkspace(workspaceId);
    },

    async getDeploymentEvents(deploymentId) {
      return store.getDeploymentEvents(deploymentId);
    },

    async validateDeployment(input, provenance) {
      assertValidProvenance(provenance);
      const replay = await findReplay(input.deploymentId, input.idempotencyKey, 'ready');
      if (replay !== null) return replay;

      const ownership = await requireOwnership(input.deploymentId);
      const deployment = ownership.deployment;
      if (deployment.status !== 'draft') {
        throw new ConflictError(
          `deployment ${input.deploymentId} is '${deployment.status}'; validation requires draft`,
        );
      }
      const scope = {
        agencyId: deployment.agencyId,
        clientId: deployment.clientId,
        workspaceId: deployment.workspaceId,
      };
      const report = await runFullGate(scope, currentSelection(deployment), 'deployment.deploy', provenance);
      const applied = await store.applyValidationSuccess(
        {
          deploymentId: deployment.deploymentId,
          idempotencyKey: input.idempotencyKey,
          expectedVersion: input.expectedVersion,
          policyReferenceId: await resolvePolicyReferenceId(scope),
          validationReport: report,
        },
        provenance,
      );
      return {
        deployment: applied.deployment,
        event: await eventById(input.deploymentId, applied.eventId),
        replayed: false,
      };
    },

    async transitionDeployment(input, provenance) {
      assertValidProvenance(provenance);
      assertValidTransitionRequest(input);
      const replay = await findReplay(input.deploymentId, input.idempotencyKey, input.to);
      if (replay !== null) return replay;

      const ownership = await requireOwnership(input.deploymentId);
      const deployment = ownership.deployment;
      const scope = {
        agencyId: deployment.agencyId,
        clientId: deployment.clientId,
        workspaceId: deployment.workspaceId,
      };
      const from = deployment.status;

      // Pre-check the frozen edge (the store re-checks under the row
      // lock; this gives the precise operator error first).
      if (from === input.to) {
        throw new ConflictError(`deployment ${input.deploymentId} is already '${input.to}'`);
      }
      if (from === 'blocked' || from === 'disabled') {
        throw new ConflictError(
          `deployment ${input.deploymentId} is '${from}' (terminal — no frozen exit edge; the operator path is a NEW deployment)`,
        );
      }

      switch (input.to) {
        case 'active': {
          if (from !== 'ready' && from !== 'paused' && from !== 'redeploying' && from !== 'rolling_back') {
            throw new ConflictError(
              `illegal deployment transition ${from} -> active (frozen lifecycle)`,
            );
          }
          if (from === 'ready' || from === 'paused') {
            // DEPLOY / RESUME: the FULL activation gate re-runs FRESH —
            // every resolution check + the policy allow — before the edge.
            const policyOperation = from === 'ready' ? 'deployment.deploy' : 'deployment.resume';
            const report = await runFullGate(scope, currentSelection(deployment), policyOperation, provenance);
            const applied = await store.transitionDeployment(
              {
                deploymentId: deployment.deploymentId,
                to: 'active',
                idempotencyKey: input.idempotencyKey,
                expectedVersion: input.expectedVersion,
                reason: input.reason,
                eventType: from === 'ready' ? 'activated' : 'resumed',
                eventFromStatus: from,
                newSelection: currentSelection(deployment),
                policyReferenceId: await resolvePolicyReferenceId(scope),
                validationReport: report,
                executionRef: null,
              },
              provenance,
            );
            return {
              deployment: applied.deployment,
              event: await eventById(input.deploymentId, applied.eventId),
              replayed: false,
            };
          }
          // REDEPLOY / ROLLBACK COMPLETION: the gate runs against the
          // PENDING/TARGET selection; on success it is applied atomically
          // with the edge (future version selection changes HERE —
          // DEPLOY-AC-06).
          const pendingType: DeploymentEventType = from === 'redeploying' ? 'redeploy-requested' : 'rollback-requested';
          const appliedType: DeploymentEventType = from === 'redeploying' ? 'redeploy-applied' : 'rollback-applied';
          const pending = await store.findLatestEventOfType(deployment.deploymentId, pendingType);
          if (pending === null || pending.selection === null) {
            throw new ConflictError(
              `deployment ${deployment.deploymentId} has no pending ${from === 'redeploying' ? 'redeploy' : 'rollback'} selection to complete`,
            );
          }
          const report = await runFullGate(scope, pending.selection, from === 'redeploying' ? 'deployment.redeploy' : 'deployment.rollback', provenance);
          const applied = await store.transitionDeployment(
            {
              deploymentId: deployment.deploymentId,
              to: 'active',
              idempotencyKey: input.idempotencyKey,
              expectedVersion: input.expectedVersion,
              reason: input.reason,
              eventType: appliedType,
              eventFromStatus: from,
              newSelection: pending.selection,
              policyReferenceId: await resolvePolicyReferenceId(scope),
              validationReport: report,
              executionRef: null,
            },
            provenance,
          );
          return {
            deployment: applied.deployment,
            event: await eventById(input.deploymentId, applied.eventId),
            replayed: false,
          };
        }
        case 'paused': {
          if (from !== 'active') {
            throw new ConflictError(`illegal deployment transition ${from} -> paused (frozen lifecycle)`);
          }
          await requirePolicyAllow('deployment.pause', scope, provenance);
          const applied = await store.transitionDeployment(
            {
              deploymentId: deployment.deploymentId,
              to: 'paused',
              idempotencyKey: input.idempotencyKey,
              expectedVersion: input.expectedVersion,
              reason: input.reason,
              eventType: 'paused',
              eventFromStatus: from,
              newSelection: null,
              policyReferenceId: null,
              validationReport: null,
              executionRef: null,
            },
            provenance,
          );
          return {
            deployment: applied.deployment,
            event: await eventById(input.deploymentId, applied.eventId),
            replayed: false,
          };
        }
        case 'disabled': {
          if (from !== 'active') {
            throw new ConflictError(`illegal deployment transition ${from} -> disabled (frozen lifecycle)`);
          }
          const applied = await store.transitionDeployment(
            {
              deploymentId: deployment.deploymentId,
              to: 'disabled',
              idempotencyKey: input.idempotencyKey,
              expectedVersion: input.expectedVersion,
              reason: input.reason,
              eventType: 'disabled',
              eventFromStatus: from,
              newSelection: null,
              policyReferenceId: null,
              validationReport: null,
              executionRef: null,
            },
            provenance,
          );
          return {
            deployment: applied.deployment,
            event: await eventById(input.deploymentId, applied.eventId),
            replayed: false,
          };
        }
        case 'blocked': {
          if (from !== 'ready') {
            throw new ConflictError(`illegal deployment transition ${from} -> blocked (frozen lifecycle)`);
          }
          const applied = await store.transitionDeployment(
            {
              deploymentId: deployment.deploymentId,
              to: 'blocked',
              idempotencyKey: input.idempotencyKey,
              expectedVersion: input.expectedVersion,
              reason: input.reason,
              eventType: 'blocked',
              eventFromStatus: from,
              newSelection: null,
              policyReferenceId: null,
              validationReport: null,
              executionRef: null,
            },
            provenance,
          );
          return {
            deployment: applied.deployment,
            event: await eventById(input.deploymentId, applied.eventId),
            replayed: false,
          };
        }
        case 'redeploying': {
          if (from !== 'active') {
            throw new ConflictError(`illegal deployment transition ${from} -> redeploying (frozen lifecycle)`);
          }
          if (input.redeploySelection === null) {
            throw new InvalidRequestError('Invalid deployment transition request', [
              'redeploySelection: required when to=redeploying',
            ]);
          }
          // The NEW selection's references resolve exactly like creation
          // (published in-scope playbook version; active workspace-owned
          // playbook-linked workflow definitions). The FULL availability
          // gate runs at completion.
          await requirePublishedPlaybookVersion(input.redeploySelection, scope);
          await requirePolicyAllow('deployment.redeploy', scope, provenance);
          const applied = await store.transitionDeployment(
            {
              deploymentId: deployment.deploymentId,
              to: 'redeploying',
              idempotencyKey: input.idempotencyKey,
              expectedVersion: input.expectedVersion,
              reason: input.reason,
              eventType: 'redeploy-requested',
              eventFromStatus: from,
              // The PENDING selection rides the ledger event; the row's
              // selection is NOT yet changed (the store's applySelection
              // gate only applies it on the completion edges — the
              // current status 'active' keeps the row pinned).
              newSelection: input.redeploySelection,
              policyReferenceId: null,
              validationReport: null,
              executionRef: null,
            },
            provenance,
          );
          return {
            deployment: applied.deployment,
            event: await eventById(input.deploymentId, applied.eventId),
            replayed: false,
          };
        }
        case 'rolling_back': {
          if (from !== 'active') {
            throw new ConflictError(`illegal deployment transition ${from} -> rolling_back (frozen lifecycle)`);
          }
          if (input.rollbackTargetEventId === null) {
            throw new InvalidRequestError('Invalid deployment transition request', [
              'rollbackTargetEventId: required when to=rolling_back',
            ]);
          }
          // The rollback target: a prior selection-bearing revision of
          // THIS deployment (a foreign event id is a uniform 404).
          const target = await store.getDeploymentEvent(deployment.deploymentId, input.rollbackTargetEventId);
          if (target === null) {
            throw new NotFoundError('deployment revision', input.rollbackTargetEventId);
          }
          if (target.selection === null) {
            throw new ConflictError(
              `deployment event ${input.rollbackTargetEventId} (${target.eventType}) carries no version selection to roll back to`,
            );
          }
          await requirePolicyAllow('deployment.rollback', scope, provenance);
          const applied = await store.transitionDeployment(
            {
              deploymentId: deployment.deploymentId,
              to: 'rolling_back',
              idempotencyKey: input.idempotencyKey,
              expectedVersion: input.expectedVersion,
              reason: input.reason,
              eventType: 'rollback-requested',
              eventFromStatus: from,
              // The TARGET selection rides the ledger event; the row's
              // selection is NOT yet changed (applied only on the
              // rolling_back -> active completion edge).
              newSelection: target.selection,
              policyReferenceId: null,
              validationReport: null,
              executionRef: null,
            },
            provenance,
          );
          return {
            deployment: applied.deployment,
            event: await eventById(input.deploymentId, applied.eventId),
            replayed: false,
          };
        }
        default: {
          // 'validating' and 'ready' are rejected by the input guard; the
          // exhaustive switch keeps every frozen target handled.
          throw new ConflictError(`deployment transition target '${input.to}' is not externally targetable`);
        }
      }
    },

    async requestDeploymentExecution(input, provenance) {
      assertValidProvenance(provenance);
      if (
        typeof input.triggerIndex !== 'number' ||
        !Number.isInteger(input.triggerIndex) ||
        input.triggerIndex < 0 ||
        input.triggerIndex > 15
      ) {
        throw new InvalidRequestError('Invalid deployment execution request', [
          'triggerIndex: a non-negative integer',
        ]);
      }
      if (
        typeof input.idempotencyKey !== 'string' ||
        input.idempotencyKey.length < 1 ||
        input.idempotencyKey.length > 200
      ) {
        throw new InvalidRequestError('Invalid deployment execution request', [
          'idempotencyKey: non-empty string of at most 200 characters',
        ]);
      }

      // Replay convergence: a recorded execution-requested event for this
      // key returns the recorded execution reference.
      const recorded = await store.findEventByIdempotencyKey(input.deploymentId, input.idempotencyKey);
      if (recorded !== null) {
        if (recorded.eventType !== 'execution-requested') {
          throw new ConflictError(
            `idempotency key '${input.idempotencyKey}' was recorded for '${recorded.eventType}' (event ${recorded.eventId}); a key identifies one logical command`,
          );
        }
        const current = await store.getDeployment(input.deploymentId);
        if (current === null) {
          throw new NotFoundError('deployment', input.deploymentId);
        }
        return {
          deployment: current,
          execution: {
            executionId: recorded.executionRef ?? '',
            runtimeClass: current.runtimeRequirements.runtimeClass,
            replayed: true,
          },
        };
      }

      const ownership = await requireOwnership(input.deploymentId);
      const deployment = ownership.deployment;
      if (deployment.status !== 'active') {
        throw new ConflictError(
          `deployment ${input.deploymentId} is '${deployment.status}'; execution requests require an active deployment`,
        );
      }
      const trigger = deployment.triggerConfig[input.triggerIndex];
      if (trigger === undefined) {
        throw new InvalidRequestError('Invalid deployment execution request', [
          `triggerIndex: deployment ${input.deploymentId} has ${deployment.triggerConfig.length} trigger(s)`,
        ]);
      }
      if (trigger.kind !== 'manual') {
        throw new ConflictError(
          `trigger ${input.triggerIndex} of deployment ${input.deploymentId} is '${trigger.kind}'; only manual triggers are requestable (schedule/event firing belongs to the runtime authority)`,
        );
      }

      // THE REQUEST-EXECUTION SURFACE (DEPLOY-AC-07/09): createExecution
      // through the /executions public contract — the ONLY sanctioned
      // interaction with the execution authority. The runtime class the
      // deployment DECLARES rides on the request; runtime allocation
      // belongs to the Execution/Runtime authority.
      const execution = await executions.createExecution({
        workspaceId: deployment.workspaceId,
        taskLink: {
          kind: 'external-request',
          externalRequestRef: `deployment:${deployment.deploymentId}:trigger:${input.triggerIndex}`,
        },
        executionKind: 'deterministic',
        runtimeClass: deployment.runtimeRequirements.runtimeClass,
        idempotencyKey: input.idempotencyKey,
        actorId: null,
      });

      // The request is recorded on the append-only ledger (idempotent
      // per key — the executions module converges duplicates on its own
      // §8 fence even if this insert races).
      const refreshed = await store.appendExecutionRequest(
        {
          deploymentId: deployment.deploymentId,
          idempotencyKey: input.idempotencyKey,
          executionRef: execution.executionId,
        },
        provenance,
      );
      return {
        deployment: refreshed,
        execution,
      };
    },
  };

  /** Resolves the active deployment-dimension policy version id — the
   * most specific scope first (client, then agency, then platform): the
   * reference stamp of the last successful gate. */
  async function resolvePolicyReferenceId(scope: {
    agencyId: string;
    clientId: string;
  }): Promise<string | null> {
    for (const lookupScope of [
      { agencyId: scope.agencyId, clientId: scope.clientId },
      { agencyId: scope.agencyId, clientId: null },
      { agencyId: null, clientId: null },
    ] as const) {
      const policyVersion = await policies.getActivePolicyVersion({
        scope: lookupScope,
        dimension: 'deployment',
      });
      if (policyVersion !== null) {
        return policyVersion.policyId;
      }
    }
    return null;
  }
}
