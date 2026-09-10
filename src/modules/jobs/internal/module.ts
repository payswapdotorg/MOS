/**
 * /jobs module implementation (MKT-026, JOB-001 + JOB-AC-01..03).
 *
 * Owns the JOB MARKETPLACE BOUNDARY: governed Task projections,
 * candidate-specific Offers, the concurrency-safe acceptance claim, and
 * provenance-preserving outcome submission — while PRESERVING Workflow
 * authority (read-only /workflows consumption; no instance mutation, no
 * second engine).
 *
 * Boundary composition follows the house rules:
 *   - the Task reference and scope chain are resolved THROUGH the
 *     /workflows public contract (READ-ONLY) BEFORE any write — a
 *     caller-supplied instance/node/tenant identifier is never an
 *     authorization and never traverses before resolution;
 *   - candidate profiles and eligibility are resolved through the merged
 *     /field-agents public contract — the PROFILE-ONLY matcher decides
 *     eligibility BEFORE any offer (and therefore before any Client data)
 *     is exposed to a candidate (human-agent-v1.3.md §3);
 *   - outcome evidence references are validated through the /evidence
 *     public contract (uniform 404 for unknown/foreign/cross-Client —
 *     a foreign evidence id is not a traversal oracle), with the
 *     migration-023 same-Client trigger as the DB backstop;
 *   - actor + provenance are SERVER-DERIVED: the module API takes outcome
 *     provenance as its own argument type no DTO feeds, and every
 *     actorId/userId input is server-supplied by routes from the
 *     authenticated principal;
 *   - acceptance/decline/settlement run as row-locked transactions
 *     (job-first lock ordering across every path — no deadlock cycles)
 *     with the DB fences (exactly-one-winner, one-open-per-candidate,
 *     one-outcome-per-job) as race backstops.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { DbTransaction } from '../../../platform/db/contract.ts';
import { isAgentEligibleForJob } from '../../field-agents/public.ts';
import type { WorkflowInstanceRecord } from '../../workflows/public.ts';
import type {
  JobDescriptor,
  JobOutcomeProvenance,
  JobOutcomeRecord,
  JobOutcomeRecordedProvenance,
  JobOwnerContext,
  JobRecord,
  JobOfferRecord,
  JobsModuleApi,
  JobsModuleDeps,
} from '../public.ts';
import {
  composeJobOwnerContext,
  evaluateOfferAccept,
  evaluateOfferDecline,
  isSameOutcomeSubmission,
  jobStatusAfterSettlement,
  validateJobProjection,
  validateOfferExpiry,
} from '../public.ts';
import { JobsStore } from './store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_TASK_NODE_TYPE = 'human_task';

/** Outcome-submission fingerprint (the logical-command identity for replays). */
interface OutcomeFingerprint {
  readonly outcome: 'succeeded' | 'failed';
  readonly payloadRef: string | null;
  readonly evidenceRef: string;
  readonly submittedBy: string | null;
}

function outcomeFingerprintOf(
  record: {
    readonly outcome: 'succeeded' | 'failed';
    readonly payloadRef: string | null;
    readonly evidenceRef: string;
    readonly provenance: { readonly submittedBy: string | null };
  },
): OutcomeFingerprint {
  return {
    outcome: record.outcome,
    payloadRef: record.payloadRef,
    evidenceRef: record.evidenceRef,
    submittedBy: record.provenance.submittedBy,
  };
}

export function createJobsModule(deps: JobsModuleDeps): JobsModuleApi {
  const store = new JobsStore(deps.db, deps.clock, deps.ids);
  const { workflows, fieldAgents, evidence } = deps;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Resolves the governed Task occurrence through the /workflows public
   * contract (READ-ONLY) BEFORE any write: the instance must exist
   * (uniform 404 — malformed identifiers included) and be RUNNING (the
   * Task's work must be live), and the node must exist in the instance's
   * pinned definition graph as a human_task node.
   */
  async function requireProjectableTask(
    workflowInstanceId: string,
    nodeId: string,
  ): Promise<WorkflowInstanceRecord> {
    if (!UUID_PATTERN.test(workflowInstanceId)) {
      throw new NotFoundError('workflow-instance', workflowInstanceId);
    }
    const instance = await workflows.getWorkflowInstance(workflowInstanceId);
    if (instance === null) {
      throw new NotFoundError('workflow-instance', workflowInstanceId);
    }
    if (instance.status !== 'running') {
      throw new ConflictError(
        `workflow instance ${workflowInstanceId} is ${instance.status} — Jobs project Tasks of RUNNING instances only`,
      );
    }
    const definition = await workflows.getWorkflowDefinition(instance.workflowDefinitionId);
    if (definition === null) {
      // The instance pins an ACTIVE definition (DB-fenced); null is an
      // integrity anomaly — fail closed with the uniform 404.
      throw new NotFoundError('workflow-definition', instance.workflowDefinitionId);
    }
    const node = definition.content.graph.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (node === undefined) {
      throw new NotFoundError('workflow-node', nodeId);
    }
    if (node.nodeType !== HUMAN_TASK_NODE_TYPE) {
      throw new InvalidRequestError('Job projection failed validation', [
        `nodeId: node '${nodeId}' is a ${node.nodeType} node — only human_task nodes project into Jobs`,
      ]);
    }
    return instance;
  }

  /** Applies the round-closing settlement rule on the caller's transaction. */
  async function settleJobIfRoundClosed(tx: DbTransaction, jobId: string): Promise<void> {
    const counts = await store.offerStatusCounts(tx, jobId);
    const closedTo = jobStatusAfterSettlement(counts);
    if (closedTo !== null) {
      await store.applyJobRoundClosed(tx, { jobId, to: closedTo });
    }
  }

  /** The job row, or the uniform 404 (malformed identifiers included). */
  async function requireJob(jobId: string): Promise<JobRecord> {
    if (!UUID_PATTERN.test(jobId)) {
      throw new NotFoundError('job', jobId);
    }
    const job = await store.getJob(jobId);
    if (job === null) {
      throw new NotFoundError('job', jobId);
    }
    return job;
  }

  // -------------------------------------------------------------------------
  // Projection (JOB-AC-01)
  // -------------------------------------------------------------------------

  async function projectJob(input: {
    readonly workflowInstanceId: string;
    readonly nodeId: string;
    readonly descriptor: JobDescriptor;
    readonly actorId: string | null;
  }): Promise<JobRecord> {
    const problems = [...validateJobProjection(input.descriptor)];
    if (input.nodeId.trim().length < 1 || input.nodeId.length > 200) {
      problems.push('nodeId: must be 1..200 characters');
    }
    if (problems.length > 0) {
      throw new InvalidRequestError('Job projection failed validation', problems);
    }

    // Task reference + scope resolved through /workflows BEFORE any write
    // (the scope chain is SERVER-DERIVED from the instance's owner).
    const instance = await requireProjectableTask(input.workflowInstanceId, input.nodeId);

    const inserted = await store.insertJob({
      workflowInstanceId: instance.workflowInstanceId,
      nodeId: input.nodeId,
      workspaceId: instance.workspaceId,
      clientId: instance.clientId,
      agencyId: instance.agencyId,
      title: input.descriptor.title.trim(),
      description: input.descriptor.description,
      eligibility: input.descriptor.eligibility,
      actorId: input.actorId,
    });
    if (inserted === 'task-taken') {
      throw new ConflictError(
        `Task ${input.nodeId} of workflow instance ${input.workflowInstanceId} is already projected into a Job (one Job per Task projection)`,
      );
    }
    return inserted;
  }

  // -------------------------------------------------------------------------
  // Marketplace listing (eligibility-gated, profile data only)
  // -------------------------------------------------------------------------

  async function listMarketplaceJobs(candidateAgentId: string): Promise<readonly JobRecord[]> {
    if (!UUID_PATTERN.test(candidateAgentId)) {
      throw new NotFoundError('human-agent', candidateAgentId);
    }
    const profile = await fieldAgents.getHumanAgent(candidateAgentId);
    if (profile === null) {
      throw new NotFoundError('human-agent', candidateAgentId);
    }
    // Eligibility BEFORE any Client data exposure: the pure /field-agents
    // matcher evaluates PROFILE DATA ONLY against each open-round job's
    // spec; the route serializes DESCRIPTORS ONLY.
    const offerable = await store.listOfferableJobs();
    return offerable.filter((job) => isAgentEligibleForJob(profile, job.eligibility));
  }

  // -------------------------------------------------------------------------
  // Offers
  // -------------------------------------------------------------------------

  async function createOffer(input: {
    readonly jobId: string;
    readonly candidateAgentId: string;
    readonly expiresAtIso: string;
    readonly actorId: string | null;
  }): Promise<JobOfferRecord> {
    const nowIso = deps.clock.nowIso();
    const expiryProblems = validateOfferExpiry(input.expiresAtIso, nowIso);
    if (expiryProblems.length > 0) {
      throw new InvalidRequestError('Job offer creation failed validation', expiryProblems);
    }
    if (!UUID_PATTERN.test(input.candidateAgentId)) {
      throw new NotFoundError('human-agent', input.candidateAgentId);
    }

    const job = await requireJob(input.jobId);
    if (job.status !== 'projected' && job.status !== 'offered') {
      throw new ConflictError(`job ${input.jobId} is ${job.status} — its offer round is closed`);
    }

    // The candidate Human Agent profile is resolved through the merged
    // /field-agents public contract BEFORE any write, and ELIGIBILITY is
    // evaluated BEFORE the offer (and therefore before any Client data)
    // is exposed to the candidate.
    const profile = await fieldAgents.getHumanAgent(input.candidateAgentId);
    if (profile === null) {
      throw new NotFoundError('human-agent', input.candidateAgentId);
    }
    if (profile.authorizationState !== 'active') {
      throw new ConflictError(
        `human agent ${input.candidateAgentId} is ${profile.authorizationState} and cannot receive offers`,
      );
    }
    if (!isAgentEligibleForJob(profile, job.eligibility)) {
      throw new ConflictError(
        `human agent ${input.candidateAgentId} is not eligible for job ${input.jobId} (profile-only eligibility evaluation)`,
      );
    }

    return deps.db.transaction(async (tx) => {
      // Job-first lock ordering; the round state is re-checked under the lock.
      const lockedJob = await store.lockJob(tx, input.jobId);
      if (lockedJob === null) {
        throw new NotFoundError('job', input.jobId);
      }
      if (lockedJob.status !== 'projected' && lockedJob.status !== 'offered') {
        throw new ConflictError(`job ${input.jobId} is ${lockedJob.status} — its offer round is closed`);
      }
      const inserted = await store.insertOffer(tx, {
        jobId: input.jobId,
        candidateAgentId: profile.agentId,
        candidateUserId: profile.userId,
        expiresAtIso: input.expiresAtIso,
        actorId: input.actorId,
      });
      if (inserted === 'open-taken') {
        throw new ConflictError(
          `human agent ${input.candidateAgentId} already holds an open offer for job ${input.jobId}`,
        );
      }
      if (lockedJob.status === 'projected') {
        await store.markJobOffered(tx, input.jobId);
      }
      // Read back through the transaction (uncommitted row visibility).
      const offers = await store.listOffersTx(tx, input.jobId);
      const created = offers.find(
        (offer) => offer.candidateAgentId === profile.agentId && offer.status === 'open',
      );
      if (created === undefined) {
        throw new Error(`inserted job offer for agent ${profile.agentId} could not be read back`);
      }
      return created;
    });
  }

  // -------------------------------------------------------------------------
  // Acceptance (JOB-AC-02 — the concurrency-safe claim)
  // -------------------------------------------------------------------------

  /**
   * The structured result of one claim/decline transaction. The caller
   * maps 'applied' to the API outcome and throws the ConflictError for
   * 'conflict' only AFTER the transaction COMMITS — so every durable
   * terminalization the conflict decision wrote (lazy expiry, round
   * settlement) persists even though the request outcome is a conflict.
   */
  type OfferTransactionOutcome =
    | { readonly kind: 'applied'; readonly job: JobRecord; readonly offer: JobOfferRecord; readonly replayed: boolean }
    | { readonly kind: 'conflict'; readonly message: string };

  async function acceptOffer(input: {
    readonly jobId: string;
    readonly offerId: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
  }): Promise<{ job: JobRecord; offer: JobOfferRecord; replayed: boolean }> {
    if (!UUID_PATTERN.test(input.jobId) || !UUID_PATTERN.test(input.offerId)) {
      throw new NotFoundError('job-offer', input.offerId);
    }
    const outcome = await deps.db.transaction<OfferTransactionOutcome>(async (tx) => {
      // Job-first lock ordering: the claim serializes on the job row.
      const job = await store.lockJob(tx, input.jobId);
      if (job === null) {
        throw new NotFoundError('job', input.jobId);
      }
      const offer = await store.lockOffer(tx, input.jobId, input.offerId);
      if (offer === null) {
        throw new NotFoundError('job-offer', input.offerId);
      }
      // The caller MUST be the offer's candidate: a foreign offer is a
      // uniform 404 (no existence oracle — HUMAN-AC-03 posture).
      if (offer.candidateUserId !== input.actorUserId) {
        throw new NotFoundError('job-offer', input.offerId);
      }

      const nowIso = deps.clock.nowIso();
      const decision = evaluateOfferAccept({
        offerStatus: offer.status,
        offerExpiresAt: offer.expiresAt,
        jobStatus: job.status,
        nowIso,
      });

      switch (decision.kind) {
        case 'replay': {
          // The SAME agent re-accepting the SAME offer: converge to the
          // recorded outcome — no state change, no version bump, the SAME
          // acceptance result (JOB-AC-02 idempotent replay).
          return { kind: 'applied', job, offer, replayed: true };
        }
        case 'claim': {
          const acceptedAtIso = nowIso;
          await store.applyOfferAccepted(tx, { offerId: offer.jobOfferId, acceptedAtIso });
          // Losing offers terminalize as expired (reason 'lost') — they can
          // never later claim the Job (job-offer-v1.2.md).
          await store.expireSiblingOpenOffers(tx, {
            jobId: input.jobId,
            exceptOfferId: offer.jobOfferId,
            nowIso,
          });
          await store.applyJobAccepted(tx, {
            jobId: input.jobId,
            acceptedAgentId: offer.candidateAgentId,
            acceptedUserId: offer.candidateUserId,
            acceptedOfferId: offer.jobOfferId,
            acceptedAtIso,
          });
          const jobAfter = await store.lockJob(tx, input.jobId);
          const offerAfter = await store.lockOffer(tx, input.jobId, input.offerId);
          if (jobAfter === null || offerAfter === null) {
            throw new Error(`accepted job ${input.jobId} could not be read back`);
          }
          return { kind: 'applied', job: jobAfter, offer: offerAfter, replayed: false };
        }
        case 'offer-expired': {
          // Lazy expiry terminalization: the offer is open but its immutable
          // expiry has passed — terminalize it, settle the job round if this
          // was the last open offer, then conflict cleanly (never partial).
          await store.applyOfferTerminal(tx, {
            offerId: offer.jobOfferId,
            to: 'expired',
            reason: 'expiry',
          });
          await settleJobIfRoundClosed(tx, input.jobId);
          return {
            kind: 'conflict',
            message: `job offer ${input.offerId} expired at ${offer.expiresAt} and can no longer be claimed`,
          };
        }
        case 'offer-terminal': {
          return {
            kind: 'conflict',
            message: `job offer ${input.offerId} is ${decision.status} (terminal per-offer) and cannot be claimed`,
          };
        }
        case 'job-unavailable': {
          // Acceptance of a different offer after the Job has been claimed
          // (or after the round closed): a clean conflict — never a partial
          // state, and no unrelated Client data is exposed (job-offer-v1.2).
          return {
            kind: 'conflict',
            message: `job ${input.jobId} is ${decision.status} — this offer can no longer be claimed`,
          };
        }
      }
    });
    if (outcome.kind === 'conflict') {
      throw new ConflictError(outcome.message);
    }
    return { job: outcome.job, offer: outcome.offer, replayed: outcome.replayed };
  }

  // -------------------------------------------------------------------------
  // Decline (JOB-AC-02 — idempotent decline; never affects the Task)
  // -------------------------------------------------------------------------

  async function declineOffer(input: {
    readonly jobId: string;
    readonly offerId: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
  }): Promise<{ job: JobRecord; offer: JobOfferRecord; replayed: boolean }> {
    if (!UUID_PATTERN.test(input.jobId) || !UUID_PATTERN.test(input.offerId)) {
      throw new NotFoundError('job-offer', input.offerId);
    }
    // Same posture as acceptance: the transaction COMMITS every durable
    // terminalization (lazy expiry, round settlement); the ConflictError
    // for a conflicting decision is thrown only AFTER the commit.
    const outcome = await deps.db.transaction<OfferTransactionOutcome>(async (tx) => {
      const job = await store.lockJob(tx, input.jobId);
      if (job === null) {
        throw new NotFoundError('job', input.jobId);
      }
      const offer = await store.lockOffer(tx, input.jobId, input.offerId);
      if (offer === null) {
        throw new NotFoundError('job-offer', input.offerId);
      }
      if (offer.candidateUserId !== input.actorUserId) {
        throw new NotFoundError('job-offer', input.offerId);
      }

      const nowIso = deps.clock.nowIso();
      const decision = evaluateOfferDecline({
        offerStatus: offer.status,
        offerExpiresAt: offer.expiresAt,
        jobStatus: job.status,
        nowIso,
      });

      switch (decision.kind) {
        case 'replay': {
          // Repeated decline of the SAME offer converges (JOB-AC-02).
          return { kind: 'applied', job, offer, replayed: true };
        }
        case 'decline': {
          await store.applyOfferTerminal(tx, {
            offerId: offer.jobOfferId,
            to: 'declined',
            reason: 'declined',
          });
          // When this was the round's last open offer with no winner, the
          // Job closes ('declined' when every offer was declined).
          await settleJobIfRoundClosed(tx, input.jobId);
          const jobAfter = await store.lockJob(tx, input.jobId);
          const offerAfter = await store.lockOffer(tx, input.jobId, input.offerId);
          if (jobAfter === null || offerAfter === null) {
            throw new Error(`declined job offer ${input.offerId} could not be read back`);
          }
          return { kind: 'applied', job: jobAfter, offer: offerAfter, replayed: false };
        }
        case 'offer-expired': {
          await store.applyOfferTerminal(tx, {
            offerId: offer.jobOfferId,
            to: 'expired',
            reason: 'expiry',
          });
          await settleJobIfRoundClosed(tx, input.jobId);
          return {
            kind: 'conflict',
            message: `job offer ${input.offerId} expired at ${offer.expiresAt} and can no longer be declined`,
          };
        }
        case 'offer-terminal': {
          return {
            kind: 'conflict',
            message: `job offer ${input.offerId} is ${decision.status} (terminal per-offer)${
              decision.status === 'accepted' ? ' — the claim stands and cannot be declined' : ''
            }`,
          };
        }
        case 'job-unavailable': {
          return {
            kind: 'conflict',
            message: `job ${input.jobId} is ${decision.status} — this offer can no longer be declined`,
          };
        }
      }
    });
    if (outcome.kind === 'conflict') {
      throw new ConflictError(outcome.message);
    }
    return { job: outcome.job, offer: outcome.offer, replayed: outcome.replayed };
  }

  // -------------------------------------------------------------------------
  // Outcome submission (JOB-AC-03 — provenance-preserving report)
  // -------------------------------------------------------------------------

  async function submitOutcome(input: {
    readonly jobId: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly payloadRef: string | null;
    readonly evidenceRef: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: JobOutcomeProvenance;
  }): Promise<{ job: JobRecord; outcome: JobOutcomeRecord; replayed: boolean }> {
    if (input.outcome !== 'succeeded' && input.outcome !== 'failed') {
      throw new InvalidRequestError('Job outcome submission failed validation', [
        "outcome: must be 'succeeded' or 'failed'",
      ]);
    }
    if (input.payloadRef !== null && (input.payloadRef.length < 1 || input.payloadRef.length > 500)) {
      throw new InvalidRequestError('Job outcome submission failed validation', [
        'payloadRef: must be 1..500 characters',
      ]);
    }
    if (!UUID_PATTERN.test(input.evidenceRef)) {
      throw new NotFoundError('evidence', input.evidenceRef);
    }

    // The caller MUST be the job's accepted agent — a foreign submitter
    // gets the uniform 404 (no oracle; HUMAN-AC-03: Client data is
    // accessible only inside the authorized Job scope).
    const job = await requireJob(input.jobId);
    if (job.status !== 'accepted' && job.status !== 'outcome_submitted') {
      throw new ConflictError(
        `job ${input.jobId} is ${job.status} — outcomes are submitted by the accepted agent of an ACCEPTED job`,
      );
    }
    if (job.acceptedUserId !== input.actorUserId) {
      throw new NotFoundError('job', input.jobId);
    }

    // The evidence reference is resolved THROUGH the /evidence public
    // contract BEFORE any write: unknown/foreign/cross-Client references
    // are a uniform 404 (a foreign evidence id is not a traversal oracle).
    // Evidence rows are immutable, so this pre-transaction resolution is
    // race-free; the migration-023 same-Client trigger is the backstop.
    const evidenceOwnership = await evidence.resolveEvidenceOwnership(input.evidenceRef);
    if (evidenceOwnership === null) {
      throw new NotFoundError('evidence', input.evidenceRef);
    }
    if (evidenceOwnership.scope.clientId !== job.clientId) {
      throw new NotFoundError('evidence', input.evidenceRef);
    }

    // The report context: the workflow-authoritative instance status
    // OBSERVED at report time (read-only /workflows consumption — the
    // workflow authority decides what to do with the report; Jobs never
    // own or command workflow state transitions).
    const instance = await workflows.getWorkflowInstance(job.workflowInstanceId);
    if (instance === null) {
      // FK-guaranteed to exist; defensive fail-closed uniform 404.
      throw new NotFoundError('workflow-instance', job.workflowInstanceId);
    }

    return deps.db.transaction(async (tx) => {
      const lockedJob = await store.lockJob(tx, input.jobId);
      if (lockedJob === null) {
        throw new NotFoundError('job', input.jobId);
      }
      if (lockedJob.acceptedUserId !== input.actorUserId) {
        throw new NotFoundError('job', input.jobId);
      }

      if (lockedJob.status === 'outcome_submitted') {
        // Exactly one outcome per job: a duplicate of the SAME logical
        // submission converges to the ORIGINALLY recorded outcome and
        // provenance (replay); anything else is a clean conflict (the
        // append-only outcome history can never be rewritten).
        const existing = await store.lockJobOutcome(tx, input.jobId);
        if (
          existing !== null &&
          isSameOutcomeSubmission(outcomeFingerprintOf(existing), {
            outcome: input.outcome,
            payloadRef: input.payloadRef,
            evidenceRef: input.evidenceRef,
            submittedBy: input.actorUserId,
          })
        ) {
          return { job: lockedJob, outcome: existing, replayed: true };
        }
        throw new ConflictError(
          `job ${input.jobId} already has a submitted outcome — the append-only outcome history cannot be rewritten`,
        );
      }
      if (lockedJob.status !== 'accepted') {
        throw new ConflictError(
          `job ${input.jobId} is ${lockedJob.status} — outcomes are submitted by the accepted agent of an ACCEPTED job`,
        );
      }

      // SERVER-DERIVED provenance (JOB-AC-03): the module stamps the actor
      // identity, recording time and causation from its own inputs — the
      // DTO surface can never reach these fields.
      const recordedProvenance: JobOutcomeRecordedProvenance = {
        actor: input.provenance.actor,
        recordedVia: input.provenance.recordedVia,
        correlationId: input.provenance.correlationId,
        causationId: input.provenance.causationId ?? input.jobId,
        submittedBy: input.actorUserId,
        submittedAt: deps.clock.nowIso(),
      };

      const inserted = await store.insertOutcome(tx, {
        jobId: input.jobId,
        outcome: input.outcome,
        payloadRef: input.payloadRef,
        evidenceRef: input.evidenceRef,
        reportedInstanceStatus: instance.status,
        provenance: recordedProvenance,
      });
      if (inserted === 'taken') {
        // The unique fence caught a race: a same-logical submission
        // converges; anything else conflicts (never partial, never a
        // second outcome row).
        const existing = await store.lockJobOutcome(tx, input.jobId);
        if (
          existing !== null &&
          isSameOutcomeSubmission(outcomeFingerprintOf(existing), {
            outcome: input.outcome,
            payloadRef: input.payloadRef,
            evidenceRef: input.evidenceRef,
            submittedBy: input.actorUserId,
          })
        ) {
          const jobAfter = await store.lockJob(tx, input.jobId);
          return { job: jobAfter ?? lockedJob, outcome: existing, replayed: true };
        }
        throw new ConflictError(
          `job ${input.jobId} already has a submitted outcome — the append-only outcome history cannot be rewritten`,
        );
      }

      await store.markJobOutcomeSubmitted(tx, input.jobId);
      const jobAfter = await store.lockJob(tx, input.jobId);
      const outcomeRecord = await store.lockJobOutcome(tx, input.jobId);
      if (jobAfter === null || outcomeRecord === null) {
        throw new Error(`job ${input.jobId} could not be read back after outcome submission`);
      }
      return { job: jobAfter, outcome: outcomeRecord, replayed: false };
    });
  }

  // -------------------------------------------------------------------------
  // Ownership resolution (implementation-contract §2)
  // -------------------------------------------------------------------------

  async function resolveJobOwnership(jobId: string): Promise<JobOwnerContext | null> {
    if (!UUID_PATTERN.test(jobId)) {
      return null;
    }
    const job = await store.getJob(jobId);
    if (job === null) {
      return null;
    }
    const instance = await workflows.getWorkflowInstance(job.workflowInstanceId);
    if (instance === null) {
      return null;
    }
    // Defensive scope re-verification (DB-fenced at insert; both sides are
    // immutable thereafter — a mismatch would be an integrity anomaly).
    if (
      instance.workspaceId !== job.workspaceId ||
      instance.clientId !== job.clientId ||
      instance.agencyId !== job.agencyId
    ) {
      return null;
    }
    const workflowOwnership = await workflows.resolveWorkflowOwnership(instance.workflowId);
    if (workflowOwnership === null) {
      return null;
    }
    return composeJobOwnerContext(
      job,
      instance,
      workflowOwnership.workspace,
      workflowOwnership.client,
      workflowOwnership.agency,
      deps.clock.nowIso(),
    );
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async function listOffersForCandidate(candidateUserId: string): Promise<readonly JobOfferRecord[]> {
    // The caller's own offer surface: a user without a Human Agent profile
    // has none (fail-closed 404 — resolved through the merged authority).
    if (!UUID_PATTERN.test(candidateUserId)) {
      throw new NotFoundError('human-agent-profile', candidateUserId);
    }
    const profile = await fieldAgents.getHumanAgentByUser(candidateUserId);
    if (profile === null) {
      throw new NotFoundError('human-agent-profile', candidateUserId);
    }
    return store.listOffersForCandidateAgent(profile.agentId);
  }

  return {
    projectJob,
    getJob(jobId: string) {
      if (!UUID_PATTERN.test(jobId)) return Promise.resolve(null);
      return store.getJob(jobId);
    },
    resolveJobOwnership,
    listMarketplaceJobs,
    createOffer,
    getOffer(jobId: string, offerId: string) {
      if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(offerId)) {
        return Promise.resolve(null);
      }
      return store.getOffer(jobId, offerId);
    },
    listOffersForJob(jobId: string) {
      if (!UUID_PATTERN.test(jobId)) return Promise.resolve([]);
      return store.listOffersForJob(jobId);
    },
    listOffersForCandidate,
    acceptOffer,
    declineOffer,
    submitOutcome,
    getJobOutcome(jobId: string) {
      if (!UUID_PATTERN.test(jobId)) return Promise.resolve(null);
      return store.getJobOutcome(jobId);
    },
  };
}
