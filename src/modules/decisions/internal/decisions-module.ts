/**
 * /decisions module implementation (MKT-042 — the Decision Ledger).
 *
 * Thin composition over the append-oriented store with the canonical owner
 * chain (the experiments/learnings pattern): every write resolves the
 * owning Client THROUGH the /clients canonical owner resolution and the
 * optional Workspace scope THROUGH the /workspaces canonical owner
 * resolution BEFORE any mutation (implementation-contract §2). Those two
 * resolutions arrive through the STRUCTURAL PORTS declared in the module's
 * public contract — the concrete /clients and /workspaces public-contract
 * instances are wired at the composition root. Agency/membership
 * authorization stays in /agencies — this module composes ownership with
 * that authority and never invents a second one.
 *
 * The module is the DECISION LEDGER authority only: it records proposals
 * with the full frozen vocabulary, applies the frozen disposition state
 * machine under the CAS update, records the one-shot observed outcome with
 * its execution/deployment/learning references, and appends the immutable
 * event tail. It never mutates evidence, experiments, learnings, executions
 * or deployments — those authorities are consulted READ-ONLY through their
 * public contracts for write-time reference validation (lock rule #5).
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  DecisionOwnerContext,
  DecisionsModuleApi,
  DecisionsModuleDeps,
} from '../public.ts';
import { DECISION_DISPOSITION_TABLE, composeDecisionOwnerContext } from '../public.ts';
import {
  DecisionStore,
  assertValidDecisionCreate,
  assertValidDecisionDispositionInput,
  assertValidDecisionOutcomeInput,
  assertValidDecisionProposer,
  assertValidDecisionProvenance,
  classifyDecisionWriteConflict,
  fingerprintDecisionCreate,
} from './decisions-store.ts';

export function createDecisionsModule(deps: DecisionsModuleDeps): DecisionsModuleApi {
  const store = new DecisionStore(deps.db, deps.clock, deps.ids);
  const { clients, workspaces, evidence, experiments, learnings, executions, deployments } = deps;

  return {
    async createDecision(input, proposer, provenance) {
      // Provenance and proposer are server-derived and must be complete
      // BEFORE anything else runs — incomplete values fail closed.
      assertValidDecisionProvenance(provenance);
      assertValidDecisionProposer(proposer);
      // The frozen proposal-vocabulary shapes at the authority boundary.
      assertValidDecisionCreate(input);

      // CANONICAL Client owner resolution from durable state BEFORE any
      // write (THROUGH the /clients public-contract instance). Unknown or
      // tombstoned Client → uniform 404; disabled Client blocks new use
      // (409) without rewriting history (the goals/evidence/experiments/
      // learnings policy).
      const ownership = await clients.resolveClientOwnership(input.clientId);
      if (ownership === null) {
        throw new NotFoundError('client', input.clientId);
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${input.clientId} is ${ownership.client.status}; decisions cannot be recorded`,
        );
      }

      // Optional Workspace scope: resolved canonically THROUGH the
      // /workspaces public-contract instance. Unknown, tombstoned, or
      // belonging to a DIFFERENT Client → uniform 404 (a foreign workspace
      // identifier is not a traversal/existence oracle); disabled Workspace
      // blocks new use. The DB scope trigger is the final backstop.
      if (input.workspaceId !== null) {
        const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(input.workspaceId);
        if (workspaceOwnership === null || workspaceOwnership.workspace.clientId !== input.clientId) {
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (workspaceOwnership.workspace.status !== 'active') {
          throw new ConflictError(
            `workspace ${input.workspaceId} is ${workspaceOwnership.workspace.status}; decisions cannot be scoped to it`,
          );
        }
      }

      // Write-time EVIDENCE reference validation (fail closed): every
      // cited record must resolve to an /evidence record of the SAME
      // Client — a foreign evidence identifier is indistinguishable from
      // an unknown one (uniform 404, no cross-tenant oracle). The DB
      // trigger is the race backstop.
      for (const evidenceRef of input.evidenceRefs) {
        const linked = await evidence.getEvidence(evidenceRef);
        if (linked === null || linked.clientId !== input.clientId) {
          throw new NotFoundError('evidence', evidenceRef);
        }
      }

      // Write-time HYPOTHESIS link validation (fail closed): the
      // experimentRef must resolve to an /experiments record of the SAME
      // Client (uniform 404). ANY lifecycle state is legal — the declared
      // hypothesis informs the proposal before its conclusion exists.
      if (input.experimentRef !== null) {
        const linked = await experiments.getExperiment(input.experimentRef);
        if (linked === null || linked.clientId !== input.clientId) {
          throw new NotFoundError('experiment', input.experimentRef);
        }
      }

      // Correction-link validation (fail closed): the predecessor must
      // resolve to a SAME-Client decision (uniform 404 — a foreign
      // decision identifier is not an existence oracle) that is NOT
      // already superseded (a superseded decision already has its
      // replacement — correct the successor instead). The DB trigger is
      // the race backstop.
      if (input.predecessorDecisionId !== null) {
        const predecessor = await store.getDecision(input.predecessorDecisionId);
        if (predecessor === null || predecessor.clientId !== input.clientId) {
          throw new NotFoundError('decision', input.predecessorDecisionId);
        }
        if (predecessor.disposition === 'superseded') {
          throw new ConflictError(
            `decision ${input.predecessorDecisionId} is already superseded; correct its successor instead`,
          );
        }
      }

      // The §8 create fingerprint: the deterministic digest of the
      // caller-visible proposal payload — the convergence proof for the
      // (client_id, idempotency_key) DB fence.
      const createFingerprint = fingerprintDecisionCreate(input);

      try {
        const inserted = await store.insertDecision(
          {
            clientId: input.clientId,
            workspaceId: input.workspaceId,
            agencyId: ownership.client.agencyId,
            objective: input.objective,
            context: input.context,
            hypothesisSummary: input.hypothesisSummary,
            experimentRef: input.experimentRef,
            evidenceRefs: input.evidenceRefs,
            expectedImpact: input.expectedImpact,
            uncertainty: input.uncertainty,
            expectedCost: input.expectedCost,
            alternatives: input.alternatives,
            predecessorDecisionId: input.predecessorDecisionId,
            idempotencyKey: input.idempotencyKey,
            createFingerprint,
          },
          proposer,
          provenance,
        );
        if (inserted) {
          const created = await store.findDecisionByIdempotencyKey(
            input.clientId,
            input.idempotencyKey,
          );
          if (created === null) {
            throw new Error(
              `recorded decision under key ${input.idempotencyKey} could not be read back`,
            );
          }
          return { decision: created, replayed: false };
        }
        // The §8 fence fired (a concurrent or replayed duplicate): the
        // recorded decision is the outcome the duplicate converged to; the
        // fingerprint proves the key is being reused for the SAME logical
        // command — a different payload under a recorded key is a 409.
        const recorded = await store.findDecisionByIdempotencyKey(
          input.clientId,
          input.idempotencyKey,
        );
        if (recorded === null) {
          throw new Error(
            `idempotency fence fired for client ${input.clientId} key ${input.idempotencyKey} but no decision could be read back`,
          );
        }
        if (recorded.createFingerprint !== createFingerprint) {
          throw new ConflictError(
            `idempotency key is already recorded by decision ${recorded.decisionId} for a different logical command; one key identifies one logical create`,
          );
        }
        return { decision: recorded, replayed: true };
      } catch (error) {
        // Lost a reference/scope race: the DB tenant fences rejected a
        // concurrently-changed ownership — converge to the uniform domain
        // 404/409 (never leak the raw driver error).
        const conflict = classifyDecisionWriteConflict(error);
        if (conflict === 'evidence-refs-client') {
          throw new NotFoundError('evidence', 'cited-by-decision');
        }
        if (conflict === 'experiment-ref-client') {
          throw new NotFoundError('experiment', 'cited-by-decision');
        }
        if (conflict === 'predecessor-illegal') {
          throw new NotFoundError('decision', input.predecessorDecisionId ?? '');
        }
        if (conflict === 'idempotency-fence') {
          // A concurrent same-key insert raced between the ON CONFLICT
          // path and the read-back — re-converge once through the fence.
          const recorded = await store.findDecisionByIdempotencyKey(
            input.clientId,
            input.idempotencyKey,
          );
          if (recorded !== null && recorded.createFingerprint === createFingerprint) {
            return { decision: recorded, replayed: true };
          }
          throw new ConflictError(
            `idempotency key is already recorded for a different logical command; one key identifies one logical create`,
          );
        }
        throw error;
      }
    },

    async getDecision(decisionId) {
      return store.getDecision(decisionId);
    },

    async resolveDecisionOwnership(decisionId) {
      const decision = await store.getDecision(decisionId);
      if (decision === null) return null;
      // Canonical Client ownership THROUGH the /clients public-contract
      // instance — the ONLY Client ownership authority. A deleted
      // (tombstoned) Client never resolves, so a decision owned by a
      // tombstoned Client is indistinguishable from an unknown decision
      // identifier (uniform 404 upstream).
      const clientOwnership = await clients.resolveClientOwnership(decision.clientId);
      if (clientOwnership === null) return null;
      const workspace =
        decision.workspaceId === null
          ? null
          : await workspaces.resolveWorkspaceOwnership(decision.workspaceId);
      return composeDecisionOwnerContext(
        decision,
        clientOwnership,
        workspace,
        deps.clock.nowIso(),
      );
    },

    async listDecisionsForClient(clientId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listDecisionsForClient(clientId);
    },

    async recordDecisionDisposition(decisionId, input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidDecisionProvenance(provenance);
      // Known command + successor present exactly when superseding.
      assertValidDecisionDispositionInput(input);

      // Canonical owner resolution BEFORE any dependent traversal: a
      // foreign decision identifier is indistinguishable from an unknown
      // one (uniform 404 — no cross-tenant oracle).
      const decision = await store.getDecision(decisionId);
      if (decision === null) {
        throw new NotFoundError('decision', decisionId);
      }
      const clientOwnership = await clients.resolveClientOwnership(decision.clientId);
      if (clientOwnership === null) {
        throw new NotFoundError('decision', decisionId);
      }

      // The §8 replay convergence pre-check (the deployments findReplay
      // pattern): a key recorded with the SAME target disposition
      // converges to the recorded event; a key recorded for a different
      // logical command is a 409.
      const edge = DECISION_DISPOSITION_TABLE[input.command];
      const recordedEvent = await store.findEventByIdempotencyKey(
        decisionId,
        input.idempotencyKey,
      );
      if (recordedEvent !== null) {
        if (
          recordedEvent.eventKind !== 'disposition' ||
          recordedEvent.disposition !== edge.to
        ) {
          throw new ConflictError(
            `idempotency key is already recorded as event ${recordedEvent.eventId} on decision ${decisionId}; one key identifies one logical command`,
          );
        }
        const current = await store.getDecision(decisionId);
        if (current === null) {
          throw new NotFoundError('decision', decisionId);
        }
        return { decision: current, event: recordedEvent, replayed: true };
      }

      // The frozen state machine: the command must be legal for the
      // CURRENT disposition (409 otherwise — a second disposition against
      // a terminal record never rewrites history). The DB
      // legal-successor trigger is the race backstop.
      if (decision.disposition !== edge.from) {
        throw new ConflictError(
          `decision ${decisionId} is ${decision.disposition}; disposition '${input.command}' requires ${edge.from}`,
        );
      }

      // Successor validation (supersede): the successor must exist, belong
      // to the SAME Client (uniform 404 — no cross-tenant oracle), be a
      // LIVE proposal, and carry THIS decision as its predecessor (the
      // mutual correction link — create the correction first, then
      // supersede). The DB successor trigger is the race backstop.
      if (input.command === 'supersede') {
        const successor = await store.getDecision(input.successorDecisionId ?? '');
        if (successor === null || successor.clientId !== decision.clientId) {
          throw new NotFoundError('decision', input.successorDecisionId ?? '');
        }
        if (successor.predecessorDecisionId !== decisionId) {
          throw new ConflictError(
            `decision ${input.successorDecisionId} does not declare decision ${decisionId} as its predecessor; supersession requires the successor to be its correction`,
          );
        }
        if (successor.disposition !== 'proposed') {
          throw new ConflictError(
            `decision ${input.successorDecisionId} is ${successor.disposition}; a superseding successor must be a live proposal`,
          );
        }
      }

      try {
        const event = await store.applyDisposition(decisionId, input, provenance);
        if (event === null) {
          // Lost the CAS race (a concurrent disposition won) — converge:
          // a same-key event recorded concurrently replays; anything else
          // is the uniform domain 409.
          const converged = await store.findEventByIdempotencyKey(
            decisionId,
            input.idempotencyKey,
          );
          if (
            converged !== null &&
            converged.eventKind === 'disposition' &&
            converged.disposition === edge.to
          ) {
            const current = await store.getDecision(decisionId);
            if (current === null) {
              throw new NotFoundError('decision', decisionId);
            }
            return { decision: current, event: converged, replayed: true };
          }
          throw new ConflictError(
            `decision ${decisionId} no longer accepts disposition '${input.command}'`,
          );
        }
        const updated = await store.getDecision(decisionId);
        if (updated === null) {
          throw new NotFoundError('decision', decisionId);
        }
        return { decision: updated, event, replayed: false };
      } catch (error) {
        const conflict = classifyDecisionWriteConflict(error);
        if (conflict === 'disposition-transition') {
          throw new ConflictError(
            `decision ${decisionId} no longer accepts disposition '${input.command}'`,
          );
        }
        if (conflict === 'proposal-immutable') {
          // Belt-and-suspenders: the store never rewrites proposal columns;
          // a concurrent trigger rejection still surfaces as a conflict.
          throw new ConflictError(
            `decision ${decisionId} proposal payload is immutable`,
          );
        }
        if (conflict === 'successor-illegal') {
          throw new ConflictError(
            `decision ${decisionId} can only be superseded by a live correction successor`,
          );
        }
        if (conflict === 'idempotency-fence') {
          const converged = await store.findEventByIdempotencyKey(
            decisionId,
            input.idempotencyKey,
          );
          if (
            converged !== null &&
            converged.eventKind === 'disposition' &&
            converged.disposition === edge.to
          ) {
            const current = await store.getDecision(decisionId);
            if (current === null) {
              throw new NotFoundError('decision', decisionId);
            }
            return { decision: current, event: converged, replayed: true };
          }
          throw new ConflictError(
            `idempotency key is already recorded on decision ${decisionId}; one key identifies one logical command`,
          );
        }
        throw error;
      }
    },

    async recordObservedOutcome(decisionId, input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidDecisionProvenance(provenance);
      // The structured observation + the at-most-one implementation
      // reference + the reference shapes.
      assertValidDecisionOutcomeInput(input);

      // Canonical owner resolution BEFORE any dependent traversal: a
      // foreign decision identifier is indistinguishable from an unknown
      // one (uniform 404 — no cross-tenant oracle).
      const decision = await store.getDecision(decisionId);
      if (decision === null) {
        throw new NotFoundError('decision', decisionId);
      }
      const clientOwnership = await clients.resolveClientOwnership(decision.clientId);
      if (clientOwnership === null) {
        throw new NotFoundError('decision', decisionId);
      }

      // The §8 replay convergence pre-check: a key recorded for an outcome
      // of THIS decision converges; a key recorded for a different event
      // kind is a 409.
      const recordedEvent = await store.findEventByIdempotencyKey(
        decisionId,
        input.idempotencyKey,
      );
      if (recordedEvent !== null) {
        if (recordedEvent.eventKind !== 'outcome_observed') {
          throw new ConflictError(
            `idempotency key is already recorded as event ${recordedEvent.eventId} on decision ${decisionId}; one key identifies one logical command`,
          );
        }
        const current = await store.getDecision(decisionId);
        if (current === null) {
          throw new NotFoundError('decision', decisionId);
        }
        return { decision: current, event: recordedEvent, replayed: true };
      }

      // The one-shot outcome rule: only an ACCEPTED decision may record an
      // observed outcome (a rejected/superseded decision was never carried
      // out), and it records exactly ONE (a corrected outcome is a NEW
      // decision, never a rewrite).
      if (decision.disposition !== 'accepted') {
        throw new ConflictError(
          `decision ${decisionId} is ${decision.disposition}; only an accepted decision records an observed outcome`,
        );
      }
      if (decision.observedOutcome !== null) {
        throw new ConflictError(
          `decision ${decisionId} already records an observed outcome; a corrected outcome is a new decision`,
        );
      }

      // Write-time IMPLEMENTATION reference validation (fail closed): the
      // executionRef must resolve to an /executions record of the SAME
      // Client; the deploymentRef to a /deployments record of the SAME
      // Client — uniform 404s, no cross-tenant oracle. The DB triggers
      // are the race backstops.
      if (input.executionRef !== null) {
        const linked = await executions.getExecution(input.executionRef);
        if (linked === null || linked.clientId !== decision.clientId) {
          throw new NotFoundError('execution', input.executionRef);
        }
      }
      if (input.deploymentRef !== null) {
        const linked = await deployments.getDeployment(input.deploymentRef);
        if (linked === null || linked.clientId !== decision.clientId) {
          throw new NotFoundError('deployment', input.deploymentRef);
        }
      }

      // Write-time LEARNING reference validation (fail closed): the
      // learningRef must resolve to a /learnings record of the SAME Client
      // (uniform 404). The DB trigger is the race backstop.
      if (input.learningRef !== null) {
        const linked = await learnings.getLearning(input.learningRef);
        if (linked === null || linked.clientId !== decision.clientId) {
          throw new NotFoundError('learning', input.learningRef);
        }
      }

      try {
        const event = await store.applyOutcome(decisionId, input, provenance);
        if (event === null) {
          // Lost the CAS race (not accepted anymore, or already observed)
          // — converge: a same-key event recorded concurrently replays;
          // anything else is the uniform domain 409.
          const converged = await store.findEventByIdempotencyKey(
            decisionId,
            input.idempotencyKey,
          );
          if (
            converged !== null &&
            converged.eventKind === 'outcome_observed'
          ) {
            const current = await store.getDecision(decisionId);
            if (current === null) {
              throw new NotFoundError('decision', decisionId);
            }
            return { decision: current, event: converged, replayed: true };
          }
          throw new ConflictError(
            `decision ${decisionId} no longer accepts an observed outcome`,
          );
        }
        const updated = await store.getDecision(decisionId);
        if (updated === null) {
          throw new NotFoundError('decision', decisionId);
        }
        return { decision: updated, event, replayed: false };
      } catch (error) {
        const conflict = classifyDecisionWriteConflict(error);
        if (conflict === 'outcome-refs-client') {
          throw new NotFoundError('decision', decisionId);
        }
        if (conflict === 'proposal-immutable') {
          throw new ConflictError(
            `decision ${decisionId} proposal payload is immutable`,
          );
        }
        if (conflict === 'idempotency-fence') {
          const converged = await store.findEventByIdempotencyKey(
            decisionId,
            input.idempotencyKey,
          );
          if (converged !== null && converged.eventKind === 'outcome_observed') {
            const current = await store.getDecision(decisionId);
            if (current === null) {
              throw new NotFoundError('decision', decisionId);
            }
            return { decision: current, event: converged, replayed: true };
          }
          throw new ConflictError(
            `idempotency key is already recorded on decision ${decisionId}; one key identifies one logical command`,
          );
        }
        throw error;
      }
    },

    async listDecisionEvents(decisionId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership: DecisionOwnerContext | null =
        await this.resolveDecisionOwnership(decisionId);
      if (ownership === null) {
        throw new NotFoundError('decision', decisionId);
      }
      return store.listEventsForDecision(decisionId);
    },
  };
}
