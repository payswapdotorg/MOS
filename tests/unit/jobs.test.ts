/**
 * MKT-026 unit tests — the frozen Job marketplace model as PURE functions
 * (spec/job-offer-v1.2.md; spec/human-agent-v1.3.md §3/§4; spec/
 * implementation-clarifications-v1.2.md "Job Offers"; requirements
 * JOB-001; the MKT-026 Work Order's status lifecycle).
 *
 * Proofs:
 *   - JOB_STATUSES/JOB_TRANSITIONS are exactly the frozen MKT-026
 *     lifecycle: projected → offered; offered → accepted | declined |
 *     expired; accepted → outcome_submitted; declined/expired/
 *     outcome_submitted TERMINAL (no re-projection, no back-edges, no
 *     skip-edges — MKT-026 is the boundary; relationship continuity is a
 *     later Work Item);
 *   - OFFER_STATUSES/OFFER_TRANSITIONS are exactly the per-offer machine
 *     (open → accepted | declined | expired | withdrawn, terminal states
 *     frozen — "losing offers … cannot later claim the Job");
 *   - validateJobProjection accepts a complete descriptor and rejects
 *     every malformed variant (title/description/eligibility shape);
 *   - validateOfferExpiry enforces the bounded future window;
 *   - evaluateOfferAccept is the idempotent-claim decision (JOB-AC-02
 *     semantics): replay for the already-accepted offer, claim for the
 *     live open offer, offer-expired for the past-expiry open offer,
 *     offer-terminal for terminal offers, job-unavailable for a claimed
 *     or closed job — and it is PURE (identical inputs → identical
 *     outputs);
 *   - evaluateOfferDecline: replay for the already-declined offer,
 *     decline for the live open offer, terminal states conflict;
 *   - jobStatusAfterSettlement: the round closes 'declined' only when
 *     EVERY offer was declined, 'expired' for terminal-no-winner with at
 *     least one non-declined terminal, null while offers remain open or
 *     a winner exists;
 *   - isSameOutcomeSubmission: the outcome replay fingerprint (outcome +
 *     payload + evidence + actor; provenance bookkeeping excluded);
 *   - composeJobOwnerContext: pure canonical owner composition.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_OFFERABLE_STATUSES,
  JOB_STATUSES,
  JOB_TERMINAL_STATUSES,
  JOB_TRANSITIONS,
  MAX_OFFER_TTL_MS,
  OFFER_STATUSES,
  OFFER_STATUS_TERMINAL_REASONS,
  OFFER_TERMINAL_REASONS,
  OFFER_TRANSITIONS,
  composeJobOwnerContext,
  evaluateOfferAccept,
  evaluateOfferDecline,
  isLegalJobTransition,
  isLegalOfferTransition,
  isSameOutcomeSubmission,
  isTerminalJobStatus,
  isTerminalOfferStatus,
  jobStatusAfterSettlement,
  validateJobProjection,
  validateOfferExpiry,
  type JobDescriptor,
} from '../../src/modules/jobs/public.ts';
import type { JobEligibilitySpecOverride } from './jobs-test-types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = '2026-01-15T12:00:00.000Z';
const LATER = '2026-01-15T13:00:00.000Z';
const MUCH_LATER = '2026-02-15T13:00:00.000Z';

const VALID_DESCRIPTOR: JobDescriptor = {
  title: 'Canvassing visit — downtown district',
  description: 'Visit the listed venues and collect the signed feedback forms.',
  eligibility: {
    specialization: 'field_agent',
    requiredCapabilities: ['canvassing'],
    territory: { kind: 'city', value: 'Accra' },
    availability: { dayOfWeek: 2, startMinute: 540, endMinute: 1020 },
  },
};

function descriptorWith(overrides: {
  title?: string;
  description?: string;
  eligibility?: JobEligibilitySpecOverride;
}): JobDescriptor {
  return {
    title: overrides.title ?? VALID_DESCRIPTOR.title,
    description: overrides.description ?? VALID_DESCRIPTOR.description,
    eligibility: {
      ...VALID_DESCRIPTOR.eligibility,
      ...(overrides.eligibility ?? {}),
    } as JobDescriptor['eligibility'],
  };
}

// ---------------------------------------------------------------------------
// Job status machine (the frozen MKT-026 lifecycle)
// ---------------------------------------------------------------------------

test('JOB_STATUSES is exactly the frozen MKT-026 lifecycle vocabulary', () => {
  assert.deepEqual([...JOB_STATUSES], [
    'projected',
    'offered',
    'accepted',
    'declined',
    'expired',
    'outcome_submitted',
  ]);
});

test('JOB_TRANSITIONS is exactly the frozen edge set (no self-loops, no back-edges, no skip-edges)', () => {
  assert.deepEqual(JOB_TRANSITIONS, {
    projected: ['offered'],
    offered: ['accepted', 'declined', 'expired'],
    accepted: ['outcome_submitted'],
    declined: [],
    expired: [],
    outcome_submitted: [],
  });
});

test('the three job terminal states are frozen; isLegalJobTransition/isTerminalJobStatus agree with the table', () => {
  assert.deepEqual([...JOB_TERMINAL_STATUSES], ['declined', 'expired', 'outcome_submitted']);
  for (const from of JOB_STATUSES) {
    for (const to of JOB_STATUSES) {
      assert.equal(
        isLegalJobTransition(from, to),
        JOB_TRANSITIONS[from].includes(to),
        `isLegalJobTransition(${from}, ${to}) must mirror the table`,
      );
    }
  }
  for (const status of JOB_STATUSES) {
    assert.equal(
      isTerminalJobStatus(status),
      JOB_TERMINAL_STATUSES.includes(status),
      `isTerminalJobStatus(${status}) must mirror the terminal set`,
    );
  }
});

test('offerable statuses are exactly the open round (projected/offered)', () => {
  assert.deepEqual([...JOB_OFFERABLE_STATUSES], ['projected', 'offered']);
});

// ---------------------------------------------------------------------------
// Offer status machine (job-offer-v1.2.md)
// ---------------------------------------------------------------------------

test('OFFER_STATUSES is exactly the per-offer vocabulary (open + the four terminals)', () => {
  assert.deepEqual([...OFFER_STATUSES], ['open', 'accepted', 'declined', 'expired', 'withdrawn']);
});

test('OFFER_TRANSITIONS: open → the four terminals; every terminal has no outgoing edge', () => {
  assert.deepEqual(OFFER_TRANSITIONS, {
    open: ['accepted', 'declined', 'expired', 'withdrawn'],
    accepted: [],
    declined: [],
    expired: [],
    withdrawn: [],
  });
  for (const from of OFFER_STATUSES) {
    for (const to of OFFER_STATUSES) {
      assert.equal(
        isLegalOfferTransition(from, to),
        OFFER_TRANSITIONS[from].includes(to),
        `isLegalOfferTransition(${from}, ${to}) must mirror the table`,
      );
    }
  }
  for (const status of OFFER_STATUSES) {
    assert.equal(
      isTerminalOfferStatus(status),
      status !== 'open',
      `every non-open offer status is terminal (${status})`,
    );
  }
});

test('terminal reasons: the frozen vocabulary and the per-status mapping (claimed/declined/expiry/withdrawn)', () => {
  assert.deepEqual([...OFFER_TERMINAL_REASONS], [
    'claimed',
    'declined',
    'expiry',
    'lost',
    'withdrawn',
  ]);
  assert.deepEqual(OFFER_STATUS_TERMINAL_REASONS, {
    open: null,
    accepted: 'claimed',
    declined: 'declined',
    // The reason recorded with an expired row distinguishes 'expiry'
    // (the expiry passed) from 'lost' (a different offer won) at write
    // time; the mapping documents the default vocabulary.
    expired: 'expiry',
    withdrawn: 'withdrawn',
  });
});

// ---------------------------------------------------------------------------
// Job projection validation
// ---------------------------------------------------------------------------

test('validateJobProjection accepts a complete descriptor (empty problems)', () => {
  assert.deepEqual(validateJobProjection(VALID_DESCRIPTOR), []);
});

test('validateJobProjection rejects malformed titles and descriptions', () => {
  assert.ok(validateJobProjection(descriptorWith({ title: '' })).length > 0);
  assert.ok(validateJobProjection(descriptorWith({ title: '   ' })).length > 0);
  assert.ok(
    validateJobProjection(descriptorWith({ title: 'x'.repeat(201) })).length > 0,
  );
  assert.ok(
    validateJobProjection(descriptorWith({ description: 'y'.repeat(2001) })).length > 0,
  );
  assert.equal(
    validateJobProjection(descriptorWith({ description: '' })).length,
    0,
    'an empty description is legal',
  );
});

test('validateJobProjection rejects unknown specializations', () => {
  const problems = validateJobProjection(
    descriptorWith({
      eligibility: { specialization: 'robot_operator' as never },
    }),
  );
  assert.ok(problems.some((problem) => problem.includes('unknown specialization')));
});

test('validateJobProjection rejects malformed required capabilities', () => {
  const badSkill = validateJobProjection(
    descriptorWith({
      eligibility: { requiredCapabilities: ['Bad Skill!'] },
    }),
  );
  assert.ok(badSkill.some((p) => p.includes('not a valid normalized skill tag')));

  const duplicate = validateJobProjection(
    descriptorWith({
      eligibility: { requiredCapabilities: ['canvassing', 'canvassing'] },
    }),
  );
  assert.ok(duplicate.some((p) => p.includes('duplicate skill')));

  const tooMany = validateJobProjection(
    descriptorWith({
      eligibility: {
        requiredCapabilities: Array.from({ length: 51 }, (_, i) => `skill_${i}`),
      },
    }),
  );
  assert.ok(tooMany.some((p) => p.includes('at most 50')));
});

test('validateJobProjection rejects malformed territories', () => {
  const badKind = validateJobProjection(
    descriptorWith({
      eligibility: { territory: { kind: 'continent' as never, value: 'Africa' } },
    }),
  );
  assert.ok(badKind.some((p) => p.includes('not a valid territory kind')));

  const badValue = validateJobProjection(
    descriptorWith({
      eligibility: { territory: { kind: 'city', value: 'X@!' } },
    }),
  );
  assert.ok(badValue.some((p) => p.includes('territory')));
});

test('validateJobProjection rejects malformed availability windows', () => {
  const badDay = validateJobProjection(
    descriptorWith({
      eligibility: { availability: { dayOfWeek: 7, startMinute: 540, endMinute: 1020 } },
    }),
  );
  assert.ok(badDay.some((p) => p.includes('dayOfWeek')));

  const inverted = validateJobProjection(
    descriptorWith({
      eligibility: { availability: { dayOfWeek: 2, startMinute: 1020, endMinute: 540 } },
    }),
  );
  assert.ok(inverted.some((p) => p.includes('must be before endMinute')));

  const badMinutes = validateJobProjection(
    descriptorWith({
      eligibility: { availability: { dayOfWeek: 2, startMinute: -1, endMinute: 1441 } },
    }),
  );
  assert.ok(badMinutes.some((p) => p.includes('startMinute')));
  assert.ok(badMinutes.some((p) => p.includes('endMinute')));
});

// ---------------------------------------------------------------------------
// Offer expiry validation
// ---------------------------------------------------------------------------

test('validateOfferExpiry accepts a bounded future timestamp', () => {
  assert.deepEqual(validateOfferExpiry(LATER, NOW), []);
  assert.deepEqual(validateOfferExpiry(MUCH_LATER, NOW), []);
});

test('validateOfferExpiry rejects past, non-ISO and over-horizon expiries', () => {
  assert.ok(validateOfferExpiry(NOW, NOW).some((p) => p.includes('future')));
  assert.ok(validateOfferExpiry('2026-01-14T12:00:00.000Z', NOW).some((p) => p.includes('future')));
  assert.ok(validateOfferExpiry('not-a-timestamp', NOW).some((p) => p.includes('ISO-8601')));
  const far = new Date(Date.parse(NOW) + MAX_OFFER_TTL_MS + 60_000).toISOString();
  assert.ok(validateOfferExpiry(far, NOW).some((p) => p.includes('at most')));
});

// ---------------------------------------------------------------------------
// The acceptance decision (JOB-AC-02 — idempotent claim semantics)
// ---------------------------------------------------------------------------

test('evaluateOfferAccept: the already-accepted offer is a REPLAY (same agent, same outcome)', () => {
  assert.deepEqual(
    evaluateOfferAccept({
      offerStatus: 'accepted',
      offerExpiresAt: LATER,
      jobStatus: 'accepted',
      nowIso: NOW,
    }),
    { kind: 'replay' },
  );
});

test('evaluateOfferAccept: terminal offers can never claim (losing offers cannot later claim)', () => {
  for (const status of ['declined', 'expired', 'withdrawn'] as const) {
    assert.deepEqual(
      evaluateOfferAccept({
        offerStatus: status,
        offerExpiresAt: LATER,
        jobStatus: 'offered',
        nowIso: NOW,
      }),
      { kind: 'offer-terminal', status },
    );
  }
});

test('evaluateOfferAccept: an open offer past its immutable expiry is expired (lazy terminalization)', () => {
  assert.deepEqual(
    evaluateOfferAccept({
      offerStatus: 'open',
      offerExpiresAt: NOW,
      jobStatus: 'offered',
      nowIso: LATER,
    }),
    { kind: 'offer-expired' },
  );
  assert.deepEqual(
    evaluateOfferAccept({
      offerStatus: 'open',
      offerExpiresAt: NOW,
      jobStatus: 'offered',
      nowIso: NOW,
    }),
    { kind: 'offer-expired' },
    'expiry is inclusive: at the expiry instant the offer is expired',
  );
});

test('evaluateOfferAccept: a claimed or closed job is a clean job-unavailable conflict (never partial)', () => {
  for (const status of ['accepted', 'declined', 'expired', 'outcome_submitted'] as const) {
    assert.deepEqual(
      evaluateOfferAccept({
        offerStatus: 'open',
        offerExpiresAt: LATER,
        jobStatus: status,
        nowIso: NOW,
      }),
      { kind: 'job-unavailable', status },
    );
  }
});

test('evaluateOfferAccept: a live open offer on an offerable job is the claim', () => {
  assert.deepEqual(
    evaluateOfferAccept({
      offerStatus: 'open',
      offerExpiresAt: LATER,
      jobStatus: 'offered',
      nowIso: NOW,
    }),
    { kind: 'claim' },
  );
  assert.deepEqual(
    evaluateOfferAccept({
      offerStatus: 'open',
      offerExpiresAt: LATER,
      jobStatus: 'projected',
      nowIso: NOW,
    }),
    { kind: 'claim' },
  );
});

test('evaluateOfferAccept is PURE: identical inputs produce identical outputs', () => {
  const input = {
    offerStatus: 'open' as const,
    offerExpiresAt: LATER,
    jobStatus: 'offered' as const,
    nowIso: NOW,
  };
  assert.deepEqual(evaluateOfferAccept(input), evaluateOfferAccept(input));
  const replayInput = {
    offerStatus: 'accepted' as const,
    offerExpiresAt: LATER,
    jobStatus: 'outcome_submitted' as const,
    nowIso: NOW,
  };
  assert.deepEqual(evaluateOfferAccept(replayInput), evaluateOfferAccept(replayInput));
});

// ---------------------------------------------------------------------------
// The decline decision (JOB-AC-02 — idempotent decline)
// ---------------------------------------------------------------------------

test('evaluateOfferDecline: the already-declined offer is a REPLAY', () => {
  assert.deepEqual(
    evaluateOfferDecline({
      offerStatus: 'declined',
      offerExpiresAt: LATER,
      jobStatus: 'offered',
      nowIso: NOW,
    }),
    { kind: 'replay' },
  );
});

test('evaluateOfferDecline: an ACCEPTED offer cannot be declined (the claim stands)', () => {
  assert.deepEqual(
    evaluateOfferDecline({
      offerStatus: 'accepted',
      offerExpiresAt: LATER,
      jobStatus: 'accepted',
      nowIso: NOW,
    }),
    { kind: 'offer-terminal', status: 'accepted' },
  );
});

test('evaluateOfferDecline: expired/withdrawn offers are terminal; a past expiry is expired', () => {
  assert.deepEqual(
    evaluateOfferDecline({
      offerStatus: 'withdrawn',
      offerExpiresAt: LATER,
      jobStatus: 'offered',
      nowIso: NOW,
    }),
    { kind: 'offer-terminal', status: 'withdrawn' },
  );
  assert.deepEqual(
    evaluateOfferDecline({
      offerStatus: 'open',
      offerExpiresAt: NOW,
      jobStatus: 'offered',
      nowIso: LATER,
    }),
    { kind: 'offer-expired' },
  );
});

test('evaluateOfferDecline: a live open offer on an offerable job is the decline (never affects the Task)', () => {
  assert.deepEqual(
    evaluateOfferDecline({
      offerStatus: 'open',
      offerExpiresAt: LATER,
      jobStatus: 'offered',
      nowIso: NOW,
    }),
    { kind: 'decline' },
  );
});

// ---------------------------------------------------------------------------
// Round settlement (the job-level closing rule)
// ---------------------------------------------------------------------------

test('jobStatusAfterSettlement: no transition while open offers remain or a winner exists', () => {
  assert.equal(
    jobStatusAfterSettlement({ open: 1, accepted: 0, declined: 2, expired: 0, withdrawn: 0 }),
    null,
  );
  assert.equal(
    jobStatusAfterSettlement({ open: 0, accepted: 1, declined: 2, expired: 0, withdrawn: 0 }),
    null,
  );
  assert.equal(jobStatusAfterSettlement({ open: 0, accepted: 0, declined: 0, expired: 0, withdrawn: 0 }), null);
});

test('jobStatusAfterSettlement: every offer declined → the job closes declined', () => {
  assert.equal(
    jobStatusAfterSettlement({ open: 0, accepted: 0, declined: 3, expired: 0, withdrawn: 0 }),
    'declined',
  );
});

test('jobStatusAfterSettlement: terminal-no-winner with at least one non-declined terminal → expired', () => {
  assert.equal(
    jobStatusAfterSettlement({ open: 0, accepted: 0, declined: 1, expired: 1, withdrawn: 0 }),
    'expired',
  );
  assert.equal(
    jobStatusAfterSettlement({ open: 0, accepted: 0, declined: 0, expired: 0, withdrawn: 2 }),
    'expired',
  );
  assert.equal(
    jobStatusAfterSettlement({ open: 0, accepted: 0, declined: 0, expired: 5, withdrawn: 0 }),
    'expired',
  );
});

// ---------------------------------------------------------------------------
// Outcome replay fingerprint
// ---------------------------------------------------------------------------

test('isSameOutcomeSubmission: same logical submission matches; any content/actor difference does not', () => {
  const base = {
    outcome: 'succeeded' as const,
    payloadRef: 'object-store://outcomes/abc',
    evidenceRef: '9f1c4b0a-1111-4222-8333-444455556666',
    submittedBy: 'user-1',
  };
  assert.equal(isSameOutcomeSubmission(base, { ...base }), true);
  assert.equal(
    isSameOutcomeSubmission(base, { ...base, outcome: 'failed' as const }),
    false,
  );
  assert.equal(isSameOutcomeSubmission(base, { ...base, payloadRef: null }), false);
  assert.equal(
    isSameOutcomeSubmission(base, { ...base, evidenceRef: '9f1c4b0a-9999-4222-8333-444455556666' }),
    false,
  );
  assert.equal(isSameOutcomeSubmission(base, { ...base, submittedBy: 'user-2' }), false);
  // Provenance bookkeeping (correlation ids) is deliberately NOT part of
  // the fingerprint — a replay converges to the originally recorded
  // provenance.
  assert.equal(isSameOutcomeSubmission(base, { ...base }), true);
});

// ---------------------------------------------------------------------------
// Owner context composition (purity)
// ---------------------------------------------------------------------------

test('composeJobOwnerContext composes the canonical scope from resolved rows (pure)', () => {
  const job = {
    jobId: 'job-1',
    workflowInstanceId: 'instance-1',
    nodeId: 'node-visit',
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    agencyId: 'agency-1',
    title: 't',
    description: 'd',
    eligibility: VALID_DESCRIPTOR.eligibility,
    status: 'projected' as const,
    acceptedAgentId: null,
    acceptedUserId: null,
    acceptedOfferId: null,
    acceptedAt: null,
    createdBy: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const instance = {
    workflowInstanceId: 'instance-1',
    workflowId: 'workflow-1',
    workflowDefinitionId: 'definition-1',
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    agencyId: 'agency-1',
    status: 'running' as const,
    createdBy: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const workspace = { workspaceId: 'workspace-1' } as never;
  const client = { clientId: 'client-1' } as never;
  const agency = { agencyId: 'agency-1' } as never;
  const first = composeJobOwnerContext(job, instance, workspace, client, agency, NOW);
  const second = composeJobOwnerContext(job, instance, workspace, client, agency, NOW);
  assert.deepEqual(first, second);
  assert.equal(first.scope.kind, 'job');
  assert.equal(first.scope.jobId, 'job-1');
  assert.equal(first.scope.clientId, 'client-1');
  assert.equal(first.workflowInstance.workflowInstanceId, 'instance-1');
});
