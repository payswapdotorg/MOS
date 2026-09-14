/**
 * /sales-continuity module implementation (MKT-046 — Sales-to-Delivery
 * Continuity).
 *
 * THE ORCHESTRATOR (orchestrates, never duplicates): every mutation this
 * module can cause flows through the EXISTING public commands of the
 * composed authorities —
 *
 *   - the proposal is read through the /decisions public contract
 *     (resolveDecisionOwnership + getDecision — READ-ONLY; the
 *     disposition authority stays /decisions);
 *   - the playbook + version are created through the /playbooks public
 *     creation commands (createClientPlaybook + createPlaybookVersion);
 *   - the deployment path completes through the /playbooks lifecycle
 *     command (setPlaybookVersionStatus — the frozen draft → review →
 *     published ladder) and the /deployments public creation command
 *     (createDeployment — born DRAFT; the MKT-040
 *     validate-before-activate gate is NEVER invoked here);
 *   - the module's OWN durable state is the continuity ledger only
 *     (sales_continuity_carries + sales_continuity_events — migration
 *     040): the durable claim → completion fence that makes the carry
 *     idempotent per proposal version and preserves the provenance +
 *     version identity end-to-end.
 *
 * The claim → complete discipline (why the ledger insert PRECEDES the
 * orchestrated creation): cross-module transactions are impossible (each
 * authority owns its own queries), so the §8 source fence must be durable
 * BEFORE the playbook creation side effect — a concurrent/replayed carry
 * then converges at the fence instead of creating a second playbook. A
 * claim left 'carrying' by a crash is an UNRESOLVED claim (the v1.2/1.3
 * UNKNOWN posture): re-carrying into it is a ConflictError disclosed for
 * manual reconciliation — never a blind replay, and never a silent
 * rewrite of the carried identity.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  SalesContinuityCarryRecord,
  SalesContinuityModuleApi,
  SalesContinuityModuleDeps,
  SalesContinuityOwnerContext,
  SalesContinuityView,
} from '../public.ts';
import {
  assertValidSalesContinuityCarryInput,
  assertValidSalesContinuityDeploymentCarryInput,
  assertValidSalesContinuityProvenance,
  deriveCarriedProposalStructure,
  derivePlaybookInputs,
  fingerprintSalesContinuityCreate,
} from './continuity-derivation.ts';
import { SalesContinuityStore } from './continuity-store.ts';
// The ONE shared cross-module guard of the frozen vocabulary: the §21
// material-key backstop from the /evidence public contract (the
// /decisions precedent — applied STRUCTURALLY over the derived snapshot
// jsonb before it is persisted on the ledger).
import { containsMaterialKey } from '../../evidence/public.ts';

export function createSalesContinuityModule(
  deps: SalesContinuityModuleDeps,
): SalesContinuityModuleApi {
  const store = new SalesContinuityStore(deps.db, deps.clock, deps.ids);
  const { decisions, playbooks, deployments, clients, workspaces } = deps;

  return {
    async carryProposalToPlaybook(input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidSalesContinuityProvenance(provenance);
      // The frozen carry-input shapes at the authority boundary.
      assertValidSalesContinuityCarryInput(input);

      // CANONICAL proposal owner resolution from durable state BEFORE any
      // write (THROUGH the /decisions public-contract instance): unknown,
      // foreign or orphaned decision identifiers are the uniform 404 —
      // no cross-tenant oracle.
      const ownership = await decisions.resolveDecisionOwnership(input.decisionId);
      if (ownership === null) {
        throw new NotFoundError('decision', input.decisionId);
      }
      const decision = ownership.decision;

      // The proposal gate (a READ, never a disposition mutation): only an
      // ACCEPTED proposal is carryable — a rejected or superseded
      // proposal was never approved for delivery (a superseded one has
      // its live correction successor — carry that instead), and a
      // still-'proposed' one has not been commercially decided.
      if (decision.disposition !== 'accepted') {
        throw new ConflictError(
          `decision ${input.decisionId} is ${decision.disposition}; only an accepted proposal carries into the delivery path`,
        );
      }

      // A disabled owning Client blocks the carry (new use without
      // rewriting history — the /playbooks creation command enforces the
      // same policy; this is the early, honest 409).
      if (ownership.clientOwnership.client.status !== 'active') {
        throw new ConflictError(
          `client ${ownership.scope.clientId} is ${ownership.clientOwnership.client.status}; proposals cannot be carried`,
        );
      }

      // THE DERIVED CARRY PAYLOAD (pure, deterministic — no manual
      // re-entry anywhere) + the §21 structural backstop over the
      // snapshot before it is persisted.
      const carriedPayload = deriveCarriedProposalStructure(decision);
      if (containsMaterialKey(carriedPayload as unknown as Record<string, unknown>)) {
        throw new InvalidRequestError(
          'The carried proposal structure is not persistable',
          ['carriedPayload: material-shaped keys can never appear in carried payloads (implementation-contract §21)'],
        );
      }

      // The derived playbook creation inputs (pure) — what feeds the
      // EXISTING /playbooks creation commands below.
      const playbookInputs = derivePlaybookInputs(decision);

      // The §8 logical create fingerprint (the convergence proof for the
      // (client_id, idempotency_key) DB fence).
      const createFingerprint = fingerprintSalesContinuityCreate(input);

      // THE DURABLE CLAIM — the source fence (UNIQUE per proposal
      // version) and the logical create fence fire BEFORE the playbook
      // creation side effect, so a duplicate can never create a second
      // playbook.
      const claim = await store.insertClaim(
        {
          clientId: decision.clientId,
          agencyId: ownership.scope.agencyId,
          sourceWorkspaceId: decision.workspaceId,
          sourceDecisionId: decision.decisionId,
          sourceFingerprint: decision.createFingerprint,
          carriedPayload,
          idempotencyKey: input.idempotencyKey,
          createFingerprint,
        },
        provenance,
      );

      if (!claim.inserted) {
        // A fence fired — classify and converge (never re-run the
        // orchestrated creation: that is the whole point of the claim).
        const bySource = await store.findCarryBySource(decision.decisionId);
        if (bySource !== null) {
          if (bySource.carryState === 'carrying') {
            // An UNRESOLVED claim: the orchestration never completed
            // (crash or in-flight). NEVER blindly replay the playbook
            // creation (unknown side effects); disclose for manual
            // reconciliation.
            throw new ConflictError(
              `decision ${input.decisionId} already has an in-flight carry ${bySource.carryId}; unresolved claims are reconciled, never replayed`,
            );
          }
          return {
            carry: bySource,
            playbook: await playbooks.getPlaybook(bySource.carriedPlaybookId ?? ''),
            playbookVersion:
              bySource.carriedPlaybookVersionId === null
                ? null
                : await playbooks.getPlaybookVersion(bySource.carriedPlaybookVersionId),
            replayed: true,
          };
        }
        const byKey = await store.findCarryByIdempotencyKey(decision.clientId, input.idempotencyKey);
        if (byKey !== null) {
          if (byKey.createFingerprint === createFingerprint) {
            // Converged through the logical key (the source row is the
            // same logical create).
            if (byKey.carryState === 'carrying') {
              throw new ConflictError(
                `decision ${input.decisionId} already has an in-flight carry ${byKey.carryId}; unresolved claims are reconciled, never replayed`,
              );
            }
            return {
              carry: byKey,
              playbook: await playbooks.getPlaybook(byKey.carriedPlaybookId ?? ''),
              playbookVersion:
                byKey.carriedPlaybookVersionId === null
                  ? null
                  : await playbooks.getPlaybookVersion(byKey.carriedPlaybookVersionId),
              replayed: true,
            };
          }
          // One logical key identifies one logical create.
          throw new ConflictError(
            `idempotency key is already recorded by carry ${byKey.carryId} for a different logical command; one key identifies one logical create`,
          );
        }
        // Both reads raced a concurrent insert that has not committed
        // visibly yet — the honest retry-posture conflict (§8).
        throw new ConflictError(
          `the carry for decision ${input.decisionId} is being recorded concurrently; retry the same logical command`,
        );
      }

      // Read back the claimed row (the durable carry identity).
      const claimed = await store.findCarryBySource(decision.decisionId);
      if (claimed === null) {
        throw new Error(
          `claimed carry for decision ${input.decisionId} could not be read back`,
        );
      }

      // THE ORCHESTRATED PLAYBOOK CREATION — through the EXISTING
      // /playbooks public creation commands. actorId: the user UUID when
      // the server-derived actor is a user principal (the playbooks
      // routes' own actor derivation), null for service actors.
      const actorId = provenance.actor.startsWith('user:') ? provenance.actor.slice(5) : null;
      const playbook = await playbooks.createClientPlaybook({
        clientId: decision.clientId,
        goalId: input.goalId,
        name: playbookInputs.name,
        description: playbookInputs.description,
        actorId,
      });
      const playbookVersion = await playbooks.createPlaybookVersion({
        playbookId: playbook.playbookId,
        strategy: playbookInputs.strategy,
        deploymentMetadata: playbookInputs.deploymentMetadata,
        actorId,
      });

      // THE PLAYBOOK COMPLETION — the one-shot forward-only update
      // ('carrying' → 'carried' with the carried references), CAS-guarded
      // and trigger-backed. A lost CAS means a concurrent completion won:
      // converge to the recorded row (the carry is the durable truth).
      const completion = await store.completePlaybookCarry(
        claimed.carryId,
        {
          playbookId: playbook.playbookId,
          playbookVersionId: playbookVersion.versionId,
          versionNumber: playbookVersion.versionNumber,
        },
        provenance,
      );
      if (completion === null) {
        const converged = await store.findCarryBySource(decision.decisionId);
        if (converged !== null && converged.carryState !== 'carrying') {
          return {
            carry: converged,
            playbook: await playbooks.getPlaybook(converged.carriedPlaybookId ?? ''),
            playbookVersion:
              converged.carriedPlaybookVersionId === null
                ? null
                : await playbooks.getPlaybookVersion(converged.carriedPlaybookVersionId),
            replayed: false,
          };
        }
        // The claim exists but the completion cannot run — the honest
        // unresolved-claim conflict (never a blind second creation).
        throw new ConflictError(
          `carry ${claimed.carryId} could not complete its playbook leg; the claim stays unresolved for reconciliation`,
        );
      }

      const carried = await store.getCarry(claimed.carryId);
      if (carried === null) {
        throw new Error(`carry ${claimed.carryId} could not be read back after completion`);
      }
      return {
        carry: carried,
        playbook,
        playbookVersion,
        replayed: false,
      };
    },

    async carryPlaybookToDeployment(input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidSalesContinuityProvenance(provenance);
      // The frozen deployment-carry input shapes at the authority
      // boundary (bounded, canonical references).
      assertValidSalesContinuityDeploymentCarryInput(input);

      // Canonical carry resolution from durable state BEFORE any
      // dependent traversal: a foreign or unknown carry identifier is the
      // uniform 404 — no cross-tenant oracle.
      const carry = await store.getCarry(input.carryId);
      if (carry === null) {
        throw new NotFoundError('sales-continuity-carry', input.carryId);
      }
      // The carry's Client chain resolves canonically THROUGH the
      // /clients structural port (a tombstoned Client never resolves).
      const clientOwnership = await clients.resolveClientOwnership(carry.clientId);
      if (clientOwnership === null) {
        throw new NotFoundError('sales-continuity-carry', input.carryId);
      }

      // The §8 replay convergence pre-check (the deployments findReplay
      // pattern): a key recorded for a deployment leg of THIS carry
      // converges to the recorded outcome.
      const recordedEvent = await store.findEventByIdempotencyKey(
        input.carryId,
        input.idempotencyKey,
      );
      if (recordedEvent !== null) {
        if (recordedEvent.eventKind !== 'deployment-carried') {
          throw new ConflictError(
            `idempotency key is already recorded as event ${recordedEvent.eventId} on carry ${input.carryId}; one key identifies one logical command`,
          );
        }
        const current = await store.getCarry(input.carryId);
        if (current === null) {
          throw new NotFoundError('sales-continuity-carry', input.carryId);
        }
        const deployment = await deployments.getDeployment(current.carriedDeploymentId ?? '');
        if (deployment === null) {
          throw new NotFoundError('deployment', current.carriedDeploymentId ?? '');
        }
        return { carry: current, deployment, replayed: true };
      }

      // The one-shot deployment leg: only a 'carried' (playbook-completed)
      // carry enters the deployment path. 'carrying' is unresolved; a
      // 'deployed' carry already recorded its deployment exactly once
      // (re-request with the SAME logical key converged above; anything
      // else is the disclosed one-shot conflict).
      if (carry.carryState === 'carrying') {
        throw new ConflictError(
          `carry ${input.carryId} has not completed its playbook leg; the deployment path requires a carried playbook`,
        );
      }
      if (carry.carryState === 'deployed') {
        throw new ConflictError(
          `carry ${input.carryId} already recorded its deployment carry; one carry carries into one deployment`,
        );
      }

      // The deployment target workspace: resolved canonically THROUGH the
      // /workspaces structural port. Unknown, tombstoned, or belonging to
      // a DIFFERENT Client than the carry → the uniform 404 (isolation
      // before dependent traversal — no cross-tenant oracle); a disabled
      // workspace blocks new use (the /deployments creation command
      // enforces the same policy; this is the early, honest 409).
      const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(input.workspaceId);
      if (workspaceOwnership === null || workspaceOwnership.workspace.clientId !== carry.clientId) {
        throw new NotFoundError('workspace', input.workspaceId);
      }

      // The carried playbook version resolves THROUGH the /playbooks
      // public contract (belt-and-suspenders: the ledger linkage and the
      // authority agree).
      const carriedVersion = await playbooks.getPlaybookVersion(
        carry.carriedPlaybookVersionId ?? '',
      );
      if (carriedVersion === null) {
        throw new NotFoundError('playbook-version', carry.carriedPlaybookVersionId ?? '');
      }

      // LEG 1 — the frozen playbook lifecycle THROUGH the existing
      // setPlaybookVersionStatus command: draft → review (the editorial
      // edge), then review → published (activation — the playbook
      // authority's own NEW-USE policies run inside, never bypassed).
      // CAS: the version row's storage version bumps on each transition.
      // An ALREADY-PUBLISHED version skips the leg (the operator may
      // publish through the /playbooks routes directly — the workflow
      // definitions must be activated against a published version, so
      // publication precedes this command in the natural operator flow;
      // a draft/review version is walked up the ladder here, making a
      // retry after a definition-activation 404 convergent). A RETIRED
      // version is withdrawn history — it never enters the deployment
      // path (409).
      let versionRow = carriedVersion;
      if (versionRow.status === 'draft' || versionRow.status === 'review') {
        if (versionRow.status === 'draft') {
          versionRow = await playbooks.setPlaybookVersionStatus({
            versionId: carriedVersion.versionId,
            status: 'review',
            expectedVersion: versionRow.version,
          });
        }
        if (versionRow.status === 'review') {
          versionRow = await playbooks.setPlaybookVersionStatus({
            versionId: carriedVersion.versionId,
            status: 'published',
            expectedVersion: versionRow.version,
          });
        }
      } else if (versionRow.status !== 'published') {
        throw new ConflictError(
          `the carried playbook version ${carriedVersion.versionId} is ${carriedVersion.status}; retired versions cannot enter the deployment path`,
        );
      }

      // LEG 2 — the deployment configuration THROUGH the existing
      // createDeployment command. The selection is DERIVED from the
      // PUBLISHED version's own deployment metadata (never re-keyed
      // proposal or metadata content) + the caller's workflow definition
      // references (delivery work products). The /deployments authority
      // re-validates everything (workspace ownership, published pin,
      // ACTIVE workspace-owned playbook-linked definitions, scope
      // compatibility); the deployment is born DRAFT and the MKT-040
      // validate-before-activate gate is NEVER invoked here.
      const metadata = versionRow.deploymentMetadata;
      const deployment = await deployments.createDeployment(
        {
          workspaceId: input.workspaceId,
          selection: {
            playbookVersionId: versionRow.versionId,
            workflowDefinitionIds: [...input.workflowDefinitionIds],
            requiredDomainPacks: metadata.requiredDomainPacks.map((pack) => ({
              name: pack.name,
              versionConstraint: pack.versionConstraint,
            })),
            requiredCapabilities: metadata.requiredCapabilities.map((capability) => ({
              kind: capability.kind,
              name: capability.name,
              versionConstraint: capability.versionConstraint,
            })),
            runtimeRequirements: { runtimeClass: metadata.runtimeRequirements.runtimeClass },
            triggerConfig: metadata.triggers.map((trigger) => ({
              kind: trigger.kind,
              config: (trigger.config ?? null) as Readonly<Record<string, string>> | null,
            })),
          },
        },
        provenance,
      );

      // THE DEPLOYMENT COMPLETION — the one-shot forward-only update
      // ('carried' → 'deployed' with the deployment reference),
      // CAS-guarded and trigger-backed. A lost CAS means a concurrent
      // completion won: converge to the recorded deployment (the carry is
      // the durable truth — the deployment row itself was created through
      // the authority and stays durable either way).
      const completion = await store.completeDeploymentCarry(
        input.carryId,
        deployment.deploymentId,
        input.idempotencyKey,
        provenance,
      );
      const current = await store.getCarry(input.carryId);
      if (current === null) {
        throw new NotFoundError('sales-continuity-carry', input.carryId);
      }
      if (completion === null) {
        // A concurrent deployment-carry completion won the CAS. If the
        // recorded deployment is the SAME logical outcome, converge;
        // otherwise surface the disclosed one-shot conflict.
        if (current.carriedDeploymentId !== null) {
          const recorded = await deployments.getDeployment(current.carriedDeploymentId);
          if (recorded !== null && recorded.deploymentId === deployment.deploymentId) {
            return { carry: current, deployment: recorded, replayed: false };
          }
          if (recorded !== null) {
            return { carry: current, deployment: recorded, replayed: true };
          }
        }
        throw new ConflictError(
          `carry ${input.carryId} already recorded its deployment carry; one carry carries into one deployment`,
        );
      }
      return { carry: current, deployment, replayed: false };
    },

    async getCarry(carryId) {
      return store.getCarry(carryId);
    },

    async resolveCarryOwnership(carryId) {
      const carry = await store.getCarry(carryId);
      if (carry === null) return null;
      // Canonical Client ownership THROUGH the /clients structural port —
      // the ONLY Client ownership authority. A deleted (tombstoned)
      // Client never resolves, so a carry owned by a tombstoned Client is
      // indistinguishable from an unknown carry identifier (uniform 404
      // upstream).
      const clientOwnership = await clients.resolveClientOwnership(carry.clientId);
      if (clientOwnership === null) return null;
      return {
        scope: {
          kind: 'sales-continuity-carry' as const,
          agencyId: clientOwnership.scope.agencyId,
          clientId: carry.clientId,
          carryId: carry.carryId,
        },
        carry,
        clientOwnership,
        resolvedAt: deps.clock.nowIso(),
      } satisfies SalesContinuityOwnerContext;
    },

    async listCarriesForClient(clientId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listCarriesForClient(clientId);
    },

    async listCarryEvents(carryId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership: SalesContinuityOwnerContext | null = await this.resolveCarryOwnership(carryId);
      if (ownership === null) {
        throw new NotFoundError('sales-continuity-carry', carryId);
      }
      return store.listEventsForCarry(carryId);
    },

    async getContinuity(carryId) {
      const ownership = await this.resolveCarryOwnership(carryId);
      if (ownership === null) return null;
      return composeView(ownership.carry, deps.clock.nowIso(), { decisions, playbooks, deployments });
    },

    async getContinuityForProposal(decisionId) {
      // The proposal resolves canonically FIRST through the /decisions
      // public contract (null → the caller surfaces the uniform 404; an
      // uncarried proposal has no continuity to read).
      const decision = await decisions.getDecision(decisionId);
      if (decision === null) return null;
      const carry = await store.findCarryBySource(decisionId);
      if (carry === null) return null;
      return composeView(carry, deps.clock.nowIso(), { decisions, playbooks, deployments });
    },

    async getContinuityForPlaybook(playbookId) {
      // The playbook resolves canonically FIRST through the /playbooks
      // public contract (null → the caller surfaces the uniform 404).
      const playbook = await playbooks.getPlaybook(playbookId);
      if (playbook === null) return null;
      const carry = await store.findCarryByCarriedPlaybook(playbookId);
      if (carry === null) return null;
      return composeView(carry, deps.clock.nowIso(), { decisions, playbooks, deployments });
    },
  };
}

/**
 * The continuity view composition (the provenance round-trip in one
 * read): the carry row + the LIVE authoritative records resolved through
 * their public contracts — never copies, never stale projections of the
 * authorities (live-follow), while the carried snapshot preserves
 * exactly what was carried.
 */
async function composeView(
  carry: SalesContinuityCarryRecord,
  resolvedAt: string,
  ports: {
    readonly decisions: SalesContinuityModuleDeps['decisions'];
    readonly playbooks: SalesContinuityModuleDeps['playbooks'];
    readonly deployments: SalesContinuityModuleDeps['deployments'];
  },
): Promise<SalesContinuityView> {
  const [source, playbook, playbookVersion, deployment] = await Promise.all([
    ports.decisions.getDecision(carry.sourceDecisionId),
    carry.carriedPlaybookId === null
      ? Promise.resolve(null)
      : ports.playbooks.getPlaybook(carry.carriedPlaybookId),
    carry.carriedPlaybookVersionId === null
      ? Promise.resolve(null)
      : ports.playbooks.getPlaybookVersion(carry.carriedPlaybookVersionId),
    carry.carriedDeploymentId === null
      ? Promise.resolve(null)
      : ports.deployments.getDeployment(carry.carriedDeploymentId),
  ]);
  return {
    carry,
    source,
    playbook,
    playbookVersion,
    deployment,
    resolvedAt,
  };
}

