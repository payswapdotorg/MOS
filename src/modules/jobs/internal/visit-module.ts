/**
 * /jobs field-execution module implementation (MKT-027 — JOB-001 field
 * subset + EVID-001 field subset; JOB-AC-03..04; EVID-AC-01..03 field
 * subset).
 *
 * Owns the FIELD EXECUTION surface of the Job authority: the visit
 * lifecycle, structured outcomes, evidence capture, follow-up and the
 * derived continuity chain — while PRESERVING every frozen boundary:
 *
 *   - the visit's scope chain is INHERITED from the Job (server-derived
 *     from durable state; migration 024 DB-backstops equality — a
 *     caller-supplied scope is structurally impossible, the DTO surface
 *     rejects every scope-shaped authority field);
 *   - every mutating operation verifies the caller IS the job's ACCEPTED
 *     agent (a foreign caller gets the uniform 404 — no existence
 *     oracle; HUMAN-AC-03 posture) and that the Job is still inside its
 *     acceptance window;
 *   - evidence references are resolved THROUGH the /evidence public
 *     contract BEFORE any write (unknown/foreign/cross-Client → uniform
 *     404), with the migration-024 same-Client trigger as the backstop;
 *   - field evidence capture appends THROUGH the /evidence public
 *     contract with a SERVER-DERIVED scope (the job's Client/Workspace)
 *     and SERVER-DERIVED provenance (recordedVia 'field-agent',
 *     causation the visit id). Claims stay claims (EVID-AC-03): there
 *     is NO class-mutation path — /evidence records are immutable and
 *     this module never re-declares a class;
 *   - the observations payload is guarded with the /evidence public
 *     material-key check (§21 — secrets never appear in evidence-shaped
 *     payloads);
 *   - every lifecycle event carries FULL server-derived provenance on
 *     the append-only transition history (JOB-AC-03 posture);
 *   - continuity (JOB-AC-04) is a DERIVED read over the relationship
 *     (agency + client + target identity); history is never rewritten;
 *     the POLICY gate is the single pure predicate over the merged
 *     /field-agents profile relationship-continuity block — NO second
 *     policy engine;
 *   - NO workflow state is ever touched: the /workflows authority stays
 *     the single workflow engine (the module still consumes it
 *     READ-ONLY, as in MKT-026); visits carry no task linkage of their
 *     own — the Task reference stays on the Job;
 *   - visits are NOT a second execution engine: no dispatch, no queue,
 *     no sandbox, no retry classification, no runtime classes — the
 *     field visit is the /jobs-owned human execution record inside the
 *     acceptance window (human-agent-v1.3.md §6 "Human Agents use the
 *     existing Task, Execution, Evidence, Audit, Policy, and Workflow
 *     authorities" — the Job side of that sentence).
 *
 * Concurrency: every mutation runs in one row-locked transaction with
 * the SAME job-first lock ordering as the MKT-026 module (lock the job,
 * then the visit) — no deadlock cycles; the UNIQUE fences are the race
 * backstops.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { DbTransaction } from '../../../platform/db/contract.ts';
import { containsMaterialKey } from '../../evidence/public.ts';
import type { EvidenceClass, EvidenceQualityGrade } from '../../evidence/public.ts';
import {
  EVIDENCE_CLASSES,
  EVIDENCE_QUALITY_GRADES,
} from '../../evidence/public.ts';
import type {
  JobRecord,
  VisitCompletionOutcome,
  VisitContinuityView,
  VisitEvidenceLinkRecord,
  VisitOutcomeRecord,
  VisitProvenance,
  VisitRecord,
  VisitRecordedProvenance,
  VisitResult,
  VisitTransitionRecord,
} from '../public.ts';
import {
  evaluateVisitTransition,
  isSameVisitOutcomeSubmission,
  MAX_VISIT_REASON_LENGTH,
  validateVisitOpen,
  validateVisitOutcome,
  VISIT_RESULTS,
} from '../public.ts';
import type { JobsModuleDeps } from '../public.ts';
import type { JobsStore } from './store.ts';
import { JobsVisitStore } from './visit-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The recording-surface label for field evidence capture (frozen vocabulary). */
const FIELD_AGENT_RECORDED_VIA = 'field-agent';

/** Outcome-submission fingerprint (the logical-command identity for replays). */
interface VisitOutcomeFingerprint {
  readonly result: VisitResult;
  readonly followUpRequired: boolean;
  readonly notes: string;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly evidenceRef: string;
  readonly submittedBy: string | null;
}

function visitOutcomeFingerprintOf(
  record: {
    readonly result: VisitResult;
    readonly followUpRequired: boolean;
    readonly notes: string;
    readonly observations: Readonly<Record<string, unknown>>;
    readonly evidenceRef: string;
    readonly provenance: { readonly submittedBy: string | null };
  },
): VisitOutcomeFingerprint {
  return {
    result: record.result,
    followUpRequired: record.followUpRequired,
    notes: record.notes,
    observations: record.observations,
    evidenceRef: record.evidenceRef,
    submittedBy: record.provenance.submittedBy,
  };
}

export function createVisitOperations(
  deps: JobsModuleDeps,
  jobsStore: JobsStore,
): {
  openVisit: (input: {
    readonly jobId: string;
    readonly targetIdentity: string;
    readonly scheduledAtIso: string | null;
    readonly followUpOfVisitId: string | null;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }) => Promise<VisitRecord>;
  getVisit: (jobId: string, visitId: string) => Promise<VisitRecord | null>;
  listVisitsForJob: (jobId: string) => Promise<readonly VisitRecord[]>;
  listVisitTransitions: (visitId: string) => Promise<readonly VisitTransitionRecord[]>;
  startVisit: (input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }) => Promise<{ readonly visit: VisitRecord; readonly replayed: boolean }>;
  cancelVisit: (input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly reason: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }) => Promise<{ readonly visit: VisitRecord; readonly replayed: boolean }>;
  completeVisit: (input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly result: VisitResult;
    readonly followUpRequired: boolean;
    readonly notes: string;
    readonly observations: Readonly<Record<string, unknown>>;
    readonly evidenceRef: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }) => Promise<VisitCompletionOutcome>;
  getVisitOutcome: (visitId: string) => Promise<VisitOutcomeRecord | null>;
  captureVisitEvidence: (input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly class: string;
    readonly quality: string;
    readonly observedAtIso: string;
    readonly sourceRef: string | null;
    readonly content: Readonly<Record<string, unknown>>;
    readonly contentRef: string | null;
    readonly confidence: number | null;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }) => Promise<VisitEvidenceLinkRecord>;
  listVisitEvidence: (visitId: string) => Promise<readonly VisitEvidenceLinkRecord[]>;
  getVisitContinuity: (visitId: string) => Promise<VisitContinuityView | null>;
} {
  const store = new JobsVisitStore(deps.db, deps.clock, deps.ids);
  const { evidence, fieldAgents } = deps;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Provenance stamped by the module clock from the server-derived input. */
  function recordedProvenance(provenance: VisitProvenance): VisitRecordedProvenance {
    return {
      actor: provenance.actor,
      recordedVia: provenance.recordedVia,
      correlationId: provenance.correlationId,
      causationId: provenance.causationId,
      recordedAt: deps.clock.nowIso(),
    };
  }

  /** The job row, or the uniform 404 (malformed identifiers included). */
  async function requireJob(jobId: string): Promise<JobRecord> {
    if (!UUID_PATTERN.test(jobId)) {
      throw new NotFoundError('job', jobId);
    }
    const job = await jobsStore.getJob(jobId);
    if (job === null) {
      throw new NotFoundError('job', jobId);
    }
    return job;
  }

  /**
   * The job row VERIFIED to be the caller's own accepted claim: the job
   * must exist and the caller MUST be the accepted agent (a foreign or
   * unknown identifier is the uniform 404 — no existence oracle; the
   * commissioning side can never open/start/complete/cancel visits or
   * capture evidence on the agent's behalf).
   */
  async function requireAcceptedJob(jobId: string, actorUserId: string): Promise<JobRecord> {
    const job = await requireJob(jobId);
    if (job.acceptedUserId !== actorUserId) {
      throw new NotFoundError('job', jobId);
    }
    return job;
  }

  /** The visit nested under its job, or the uniform 404. */
  async function requireVisit(jobId: string, visitId: string): Promise<VisitRecord> {
    if (!UUID_PATTERN.test(visitId)) {
      throw new NotFoundError('visit', visitId);
    }
    const visit = await store.getVisit(jobId, visitId);
    if (visit === null) {
      throw new NotFoundError('visit', visitId);
    }
    return visit;
  }

  /**
   * One row-locked visit transaction: locks the JOB row first (the house
   * lock ordering — the same order every MKT-026 path uses), then the
   * visit row, re-verifies the accepted-agent claim under the lock, and
   * applies the decision. Conflict decisions are returned (not thrown)
   * so the transaction can COMMIT durable lazy terminalizations first —
   * the same posture as the MKT-026 offer transactions.
   */
  async function visitTransitionTransaction<T>(
    jobId: string,
    visitId: string,
    actorUserId: string,
    onLocked: (
      tx: DbTransaction,
      job: JobRecord,
      visit: VisitRecord,
    ) => Promise<T>,
  ): Promise<T> {
    return deps.db.transaction(async (tx) => {
      // Job-first lock ordering (identical to every /jobs mutation path).
      const job = await jobsStore.lockJob(tx, jobId);
      if (job === null) {
        throw new NotFoundError('job', jobId);
      }
      if (job.acceptedUserId !== actorUserId) {
        throw new NotFoundError('job', jobId);
      }
      const visit = await store.lockVisit(tx, jobId, visitId);
      if (visit === null) {
        throw new NotFoundError('visit', visitId);
      }
      return onLocked(tx, job, visit);
    });
  }

  // -------------------------------------------------------------------------
  // Open (the visit record is created inside the acceptance window)
  // -------------------------------------------------------------------------

  async function openVisit(input: {
    readonly jobId: string;
    readonly targetIdentity: string;
    readonly scheduledAtIso: string | null;
    readonly followUpOfVisitId: string | null;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<VisitRecord> {
    const problems = [
      ...validateVisitOpen({
        targetIdentity: input.targetIdentity,
        scheduledAtIso: input.scheduledAtIso,
        followUpOfVisitId: input.followUpOfVisitId,
      }),
    ];
    if (problems.length > 0) {
      throw new InvalidRequestError('Visit open failed validation', problems);
    }

    // The caller MUST be the job's accepted agent (uniform 404) and the
    // job must be inside its acceptance window.
    const job = await requireAcceptedJob(input.jobId, input.actorUserId);
    if (job.status !== 'accepted') {
      throw new ConflictError(
        `job ${input.jobId} is ${job.status} — visits exist only inside the acceptance window of an ACCEPTED job`,
      );
    }

    // The follow-up reference is resolved BEFORE any write: a foreign or
    // unknown visit identifier is the uniform 404 (no traversal oracle);
    // a same-relationship visit that is not completed conflicts; a
    // different-relationship visit conflicts (the DB trigger backstops).
    if (input.followUpOfVisitId !== null) {
      if (!UUID_PATTERN.test(input.followUpOfVisitId)) {
        throw new NotFoundError('visit', input.followUpOfVisitId);
      }
      const prior = await store.getVisitById(input.followUpOfVisitId);
      if (
        prior === null ||
        prior.agencyId !== job.agencyId ||
        prior.clientId !== job.clientId ||
        prior.targetIdentity !== input.targetIdentity
      ) {
        // Unknown, cross-tenant or different-relationship: uniform 404.
        throw new NotFoundError('visit', input.followUpOfVisitId);
      }
      if (prior.status !== 'completed') {
        throw new ConflictError(
          `visit ${input.followUpOfVisitId} is ${prior.status} — follow-ups reference COMPLETED visits only`,
        );
      }
    }

    const provenance = recordedProvenance(input.provenance);
    return deps.db.transaction(async (tx) => {
      // Job-first lock ordering; the acceptance window is re-checked
      // under the lock (the DB trigger is the final backstop).
      const lockedJob = await jobsStore.lockJob(tx, input.jobId);
      if (lockedJob === null) {
        throw new NotFoundError('job', input.jobId);
      }
      if (lockedJob.acceptedUserId !== input.actorUserId) {
        throw new NotFoundError('job', input.jobId);
      }
      if (lockedJob.status !== 'accepted') {
        throw new ConflictError(
          `job ${input.jobId} is ${lockedJob.status} — visits exist only inside the acceptance window of an ACCEPTED job`,
        );
      }
      const visitSeq = await store.nextVisitSeq(tx, input.jobId);
      // The scope chain is INHERITED from the locked job row (the visit
      // scope IS the job scope — never caller input).
      return store.insertVisit(tx, {
        jobId: lockedJob.jobId,
        visitSeq,
        workspaceId: lockedJob.workspaceId,
        clientId: lockedJob.clientId,
        agencyId: lockedJob.agencyId,
        targetIdentity: input.targetIdentity,
        scheduledAtIso: input.scheduledAtIso,
        followUpOfVisitId: input.followUpOfVisitId,
        createdBy: input.actorId,
        provenance,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Start (planned → in_progress; replay converges)
  // -------------------------------------------------------------------------

  async function startVisit(input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<{ readonly visit: VisitRecord; readonly replayed: boolean }> {
    await requireAcceptedJob(input.jobId, input.actorUserId);
    await requireVisit(input.jobId, input.visitId);

    type Result = { readonly visit: VisitRecord; readonly replayed: boolean } | { readonly conflict: string };
    const outcome = await visitTransitionTransaction<Result>(
      input.jobId,
      input.visitId,
      input.actorUserId,
      async (tx, job, visit) => {
        const decision = evaluateVisitTransition(visit.status, 'in_progress');
        switch (decision.kind) {
          case 'replay': {
            // The SAME agent re-starting an in_progress visit: converge.
            return { visit, replayed: true };
          }
          case 'apply': {
            const provenance = recordedProvenance(input.provenance);
            await store.applyVisitStarted(tx, visit.visitId);
            await store.insertTransition(tx, {
              visitId: visit.visitId,
              fromStatus: visit.status,
              toStatus: 'in_progress',
              reason: '',
              createdBy: input.actorId,
              provenance,
            });
            const after = await store.lockVisit(tx, job.jobId, visit.visitId);
            if (after === null) {
              throw new Error(`started visit ${visit.visitId} could not be read back`);
            }
            return { visit: after, replayed: false };
          }
          case 'terminal': {
            return {
              conflict: `visit ${visit.visitId} is ${decision.status} (terminal) and frozen: terminal visit states are immutable`,
            };
          }
          case 'illegal': {
            return {
              conflict: `illegal visit transition ${decision.from} → ${decision.to} (frozen MKT-027 visit state machine)`,
            };
          }
        }
      },
    );
    if ('conflict' in outcome) {
      throw new ConflictError(outcome.conflict);
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Cancel (planned | in_progress → cancelled; replay converges)
  // -------------------------------------------------------------------------

  async function cancelVisit(input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly reason: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<{ readonly visit: VisitRecord; readonly replayed: boolean }> {
    if (typeof input.reason !== 'string' || input.reason.length > MAX_VISIT_REASON_LENGTH) {
      throw new InvalidRequestError('Visit cancellation failed validation', [
        `reason: must be a string of at most ${MAX_VISIT_REASON_LENGTH} characters`,
      ]);
    }
    await requireAcceptedJob(input.jobId, input.actorUserId);
    await requireVisit(input.jobId, input.visitId);

    type Result = { readonly visit: VisitRecord; readonly replayed: boolean } | { readonly conflict: string };
    const outcome = await visitTransitionTransaction<Result>(
      input.jobId,
      input.visitId,
      input.actorUserId,
      async (tx, job, visit) => {
        const decision = evaluateVisitTransition(visit.status, 'cancelled');
        switch (decision.kind) {
          case 'replay': {
            // Repeated cancellation converges (frozen history).
            return { visit, replayed: true };
          }
          case 'apply': {
            const provenance = recordedProvenance(input.provenance);
            await store.applyVisitCancelled(tx, visit.visitId);
            await store.insertTransition(tx, {
              visitId: visit.visitId,
              fromStatus: visit.status,
              toStatus: 'cancelled',
              reason: input.reason,
              createdBy: input.actorId,
              provenance,
            });
            const after = await store.lockVisit(tx, job.jobId, visit.visitId);
            if (after === null) {
              throw new Error(`cancelled visit ${visit.visitId} could not be read back`);
            }
            return { visit: after, replayed: false };
          }
          case 'terminal': {
            return {
              conflict: `visit ${visit.visitId} is ${decision.status} (terminal) and frozen: a completed visit's outcome stands and cannot be cancelled`,
            };
          }
          case 'illegal': {
            return {
              conflict: `illegal visit transition ${decision.from} → ${decision.to} (frozen MKT-027 visit state machine)`,
            };
          }
        }
      },
    );
    if ('conflict' in outcome) {
      throw new ConflictError(outcome.conflict);
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Complete (in_progress → completed with the structured outcome —
  // JOB-AC-03 field subset)
  // -------------------------------------------------------------------------

  async function completeVisit(input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly result: VisitResult;
    readonly followUpRequired: boolean;
    readonly notes: string;
    readonly observations: Readonly<Record<string, unknown>>;
    readonly evidenceRef: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<VisitCompletionOutcome> {
    const problems = [
      ...validateVisitOutcome({
        result: input.result,
        followUpRequired: input.followUpRequired,
        notes: input.notes,
        observations: input.observations,
        evidenceRef: input.evidenceRef,
      }),
    ];
    if (!(VISIT_RESULTS as readonly string[]).includes(input.result)) {
      // Defensive: validateVisitOutcome already covers this.
      problems.push('result: unknown field result');
    }
    if (problems.length > 0) {
      throw new InvalidRequestError('Visit outcome submission failed validation', problems);
    }
    // §21 guard (the /evidence public material-key check): secrets never
    // appear in evidence-shaped payloads at any nesting level.
    if (containsMaterialKey(input.observations)) {
      throw new InvalidRequestError('Visit outcome submission failed validation', [
        'observations: material-shaped keys can never appear in observation payloads (implementation-contract §21)',
      ]);
    }
    if (!UUID_PATTERN.test(input.evidenceRef)) {
      throw new NotFoundError('evidence', input.evidenceRef);
    }

    // The caller MUST be the accepted agent (uniform 404).
    //
    // NOTE: the acceptance window guards OPENING only (exactly what the
    // migration-024 INSERT trigger enforces): a visit that already exists
    // keeps its own lifecycle (start/cancel/complete are visit-state
    // gated) — the MKT-026 Job state machine is never touched, and the
    // visit outcome remains append-only field-execution history.
    // requireAcceptedJob also resolves the job row once (the accepted
    // agent AND the client scope for the same-Client evidence check).
    const job = await requireAcceptedJob(input.jobId, input.actorUserId);
    // The visit reference is resolved (uniform 404 for foreign/unknown
    // identifiers) — the row is re-locked inside the transaction below.
    await requireVisit(input.jobId, input.visitId);

    // The evidence reference is resolved THROUGH the /evidence public
    // contract BEFORE any write: unknown/foreign/cross-Client references
    // are a uniform 404 (a foreign evidence id is not a traversal
    // oracle). Evidence rows are immutable, so this pre-transaction
    // resolution is race-free; the migration-024 same-Client trigger is
    // the backstop.
    const evidenceOwnership = await evidence.resolveEvidenceOwnership(input.evidenceRef);
    if (evidenceOwnership === null) {
      throw new NotFoundError('evidence', input.evidenceRef);
    }
    if (evidenceOwnership.scope.clientId !== job.clientId) {
      throw new NotFoundError('evidence', input.evidenceRef);
    }

    type Result = VisitCompletionOutcome | { readonly conflict: string };
    const outcome = await visitTransitionTransaction<Result>(
      input.jobId,
      input.visitId,
      input.actorUserId,
      async (tx, lockedJob, lockedVisit) => {
        const decision = evaluateVisitTransition(lockedVisit.status, 'completed');
        if (decision.kind === 'replay') {
          // Exactly one outcome per visit: a duplicate of the SAME
          // logical submission converges to the ORIGINALLY recorded
          // outcome and provenance; anything else is a clean conflict
          // (the append-only outcome history can never be rewritten).
          const existing = await store.lockVisitOutcome(tx, lockedVisit.visitId);
          if (
            existing !== null &&
            isSameVisitOutcomeSubmission(visitOutcomeFingerprintOf(existing), {
              result: input.result,
              followUpRequired: input.followUpRequired,
              notes: input.notes,
              observations: input.observations,
              evidenceRef: input.evidenceRef,
              submittedBy: input.actorUserId,
            })
          ) {
            return { visit: lockedVisit, outcome: existing, replayed: true };
          }
          return {
            conflict: `visit ${lockedVisit.visitId} already has a submitted outcome — the append-only outcome history cannot be rewritten`,
          };
        }
        if (decision.kind !== 'apply') {
          if (decision.kind === 'terminal') {
            return {
              conflict: `visit ${lockedVisit.visitId} is ${decision.status} (terminal) and frozen: terminal visit states are immutable`,
            };
          }
          return {
            conflict: `visit ${lockedVisit.visitId} is ${lockedVisit.status} — outcomes are submitted for IN-PROGRESS visits`,
          };
        }

        // SERVER-DERIVED provenance (JOB-AC-03): the module stamps the
        // actor identity, recording time and causation from its own
        // inputs — the DTO surface can never reach these fields.
        const recorded = {
          ...recordedProvenance(input.provenance),
          submittedBy: input.actorUserId,
          submittedAt: deps.clock.nowIso(),
        };

        const inserted = await store.insertVisitOutcome(tx, {
          visitId: lockedVisit.visitId,
          result: input.result,
          followUpRequired: input.followUpRequired,
          notes: input.notes,
          observations: input.observations,
          evidenceRef: input.evidenceRef,
          provenance: recorded,
        });
        if (inserted === 'taken') {
          // The unique fence caught a race: a same-logical submission
          // converges; anything else conflicts (never partial, never a
          // second outcome row).
          const existing = await store.lockVisitOutcome(tx, lockedVisit.visitId);
          if (
            existing !== null &&
            isSameVisitOutcomeSubmission(visitOutcomeFingerprintOf(existing), {
              result: input.result,
              followUpRequired: input.followUpRequired,
              notes: input.notes,
              observations: input.observations,
              evidenceRef: input.evidenceRef,
              submittedBy: input.actorUserId,
            })
          ) {
            return { visit: lockedVisit, outcome: existing, replayed: true };
          }
          return {
            conflict: `visit ${lockedVisit.visitId} already has a submitted outcome — the append-only outcome history cannot be rewritten`,
          };
        }

        await store.applyVisitCompleted(tx, lockedVisit.visitId);
        await store.insertTransition(tx, {
          visitId: lockedVisit.visitId,
          fromStatus: lockedVisit.status,
          toStatus: 'completed',
          reason: `result: ${input.result}${input.followUpRequired ? '; follow-up required' : ''}`,
          createdBy: input.actorId,
          provenance: recordedProvenance(input.provenance),
        });
        const after = await store.lockVisit(tx, lockedJob.jobId, lockedVisit.visitId);
        const outcomeRecord = await store.lockVisitOutcome(tx, lockedVisit.visitId);
        if (after === null || outcomeRecord === null) {
          throw new Error(`completed visit ${lockedVisit.visitId} could not be read back`);
        }
        return { visit: after, outcome: outcomeRecord, replayed: false };
      },
    );
    if ('conflict' in outcome) {
      throw new ConflictError(outcome.conflict);
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Evidence capture (EVID-AC-01..03 field subset — human-agent §5)
  // -------------------------------------------------------------------------

  async function captureVisitEvidence(input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly class: string;
    readonly quality: string;
    readonly observedAtIso: string;
    readonly sourceRef: string | null;
    readonly content: Readonly<Record<string, unknown>>;
    readonly contentRef: string | null;
    readonly confidence: number | null;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<VisitEvidenceLinkRecord> {
    // The declared class/quality are validated against the FROZEN closed
    // sets (the /evidence append guard re-validates at the authority
    // boundary; unknown values fail closed here with a clean 422).
    if (!(EVIDENCE_CLASSES as readonly string[]).includes(input.class)) {
      throw new InvalidRequestError('Field evidence capture failed validation', [
        `class '${input.class}' must be one of the frozen evidence classes`,
      ]);
    }
    if (!(EVIDENCE_QUALITY_GRADES as readonly string[]).includes(input.quality)) {
      throw new InvalidRequestError('Field evidence capture failed validation', [
        `quality '${input.quality}' must be one of the frozen A..F grades`,
      ]);
    }
    if (typeof input.observedAtIso !== 'string' || Number.isNaN(Date.parse(input.observedAtIso))) {
      throw new InvalidRequestError('Field evidence capture failed validation', [
        'observedAt: must be a real ISO 8601 timestamp',
      ]);
    }
    if (input.sourceRef !== null && (input.sourceRef.length < 1 || input.sourceRef.length > 512)) {
      throw new InvalidRequestError('Field evidence capture failed validation', [
        'sourceRef: must be between 1 and 512 characters when present',
      ]);
    }
    if (input.contentRef !== null && (input.contentRef.length < 1 || input.contentRef.length > 512)) {
      throw new InvalidRequestError('Field evidence capture failed validation', [
        'contentRef: must be between 1 and 512 characters when present',
      ]);
    }

    // The caller MUST be the accepted agent (uniform 404) and the visit
    // must be IN PROGRESS (evidence is captured during field execution —
    // visit-state gated, exactly like every other visit lifecycle op; the
    // acceptance window guards OPENING only). requireAcceptedJob also
    // resolves the job row once: the visit's scope (inherited from the
    // job) IS the evidence scope.
    const job = await requireAcceptedJob(input.jobId, input.actorUserId);
    const visit = await requireVisit(input.jobId, input.visitId);
    if (visit.status !== 'in_progress') {
      throw new ConflictError(
        `visit ${input.visitId} is ${visit.status} — evidence is captured during IN-PROGRESS visits`,
      );
    }

    // The append goes THROUGH the /evidence public contract with a
    // SERVER-DERIVED scope (the job's Client + Workspace — never caller
    // input) and SERVER-DERIVED provenance: the actor from the
    // authenticated principal, the recording surface 'field-agent', the
    // ambient correlation and the visit as causation. The /evidence
    // append guard enforces the frozen class/quality/content shapes and
    // the §21 material-key backstop at the authority boundary; the
    // record is IMMUTABLE from here on — claims stay claims (EVID-AC-03
    // by construction: there is no class-mutation path anywhere).
    const record = await evidence.appendEvidence(
      {
        clientId: job.clientId,
        workspaceId: job.workspaceId,
        class: input.class as EvidenceClass,
        source: {
          system: FIELD_AGENT_RECORDED_VIA,
          ref: input.sourceRef,
        },
        observedAt: input.observedAtIso,
        content: input.content,
        contentRef: input.contentRef,
        quality: input.quality as EvidenceQualityGrade,
        confidence: input.confidence,
        supersedesEvidenceId: null,
      },
      {
        actor: input.provenance.actor,
        recordedVia: FIELD_AGENT_RECORDED_VIA,
        correlationId: input.provenance.correlationId,
        causationId: input.visitId,
      },
    );

    // The visit-side attribution link (the evidence row is the authority;
    // this link is the derived index — same-Client DB-fenced, append-only).
    // The link's provenance carries the SAME capture-stamped dimensions
    // the evidence row carries: recording surface 'field-agent' and
    // causation the visit id.
    return store.insertVisitEvidenceLink({
      visitId: visit.visitId,
      evidenceId: record.evidenceId,
      capturedBy: input.actorId,
      provenance: {
        actor: input.provenance.actor,
        recordedVia: FIELD_AGENT_RECORDED_VIA,
        correlationId: input.provenance.correlationId,
        causationId: input.visitId,
        recordedAt: deps.clock.nowIso(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Continuity (JOB-AC-04 — the DERIVED relationship chain; a READ)
  // -------------------------------------------------------------------------

  async function getVisitContinuity(visitId: string): Promise<VisitContinuityView | null> {
    if (!UUID_PATTERN.test(visitId)) {
      return null;
    }
    const visit = await store.getVisitById(visitId);
    if (visit === null) {
      return null;
    }
    // The prior COMPLETED visits of the SAME relationship — derived data,
    // never rewritten. The POLICY INPUT (the agent's frozen profile
    // relationship-continuity block) is resolved server-side through the
    // merged /field-agents public contract; the route-level checkpoint
    // (visitContinuityExposedToAgent) decides exposure for the ACCEPTED
    // AGENT — the commissioning side reads through its client scope.
    const priorVisits = await store.listCompletedVisitsOfRelationship(
      {
        agencyId: visit.agencyId,
        clientId: visit.clientId,
        targetIdentity: visit.targetIdentity,
      },
      visit.visitId,
    );
    const entries = [] as Array<{ visit: VisitRecord; outcome: VisitOutcomeRecord | null }>;
    for (const prior of priorVisits) {
      const outcome = await store.getVisitOutcome(prior.visitId);
      entries.push({ visit: prior, outcome });
    }
    let agentContinuityPolicy = null;
    const job = await jobsStore.getJob(visit.jobId);
    if (job !== null && job.acceptedAgentId !== null) {
      const profile = await fieldAgents.getHumanAgent(job.acceptedAgentId);
      agentContinuityPolicy = profile === null ? null : profile.relationshipContinuity;
    }
    return {
      visit,
      relationship: {
        agencyId: visit.agencyId,
        clientId: visit.clientId,
        targetIdentity: visit.targetIdentity,
      },
      priorVisits: entries,
      agentContinuityPolicy,
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  return {
    openVisit,
    getVisit(jobId: string, visitId: string) {
      if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(visitId)) {
        return Promise.resolve(null);
      }
      return store.getVisit(jobId, visitId);
    },
    listVisitsForJob(jobId: string) {
      if (!UUID_PATTERN.test(jobId)) return Promise.resolve([]);
      return store.listVisitsForJob(jobId);
    },
    listVisitTransitions(visitId: string) {
      if (!UUID_PATTERN.test(visitId)) return Promise.resolve([]);
      return store.listVisitTransitions(visitId);
    },
    startVisit,
    cancelVisit,
    completeVisit,
    getVisitOutcome(visitId: string) {
      if (!UUID_PATTERN.test(visitId)) return Promise.resolve(null);
      return store.getVisitOutcome(visitId);
    },
    captureVisitEvidence,
    listVisitEvidence(visitId: string) {
      if (!UUID_PATTERN.test(visitId)) return Promise.resolve([]);
      return store.listVisitEvidence(visitId);
    },
    getVisitContinuity,
  };
}
