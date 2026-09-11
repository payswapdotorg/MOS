/**
 * MKT-031 unit tests — the Field Agent work-queue PURE view derivation
 * (spec/work-items.md MKT-031; requirements UI-002 + UI-AC-01: the queue
 * displays authoritative backend state, derived — never re-decided — at
 * the route layer).
 *
 * Proofs:
 *   - deriveJobObligations is the frozen obligation derivation: the job
 *     outcome is due exactly while the accepted job has no submitted
 *     outcome; open visits are the planned/in_progress ones; evidence is
 *     due for every in-progress visit with no captured evidence record
 *     (a missing count is zero — fail closed) — and it is PURE
 *     (identical inputs → identical outputs);
 *   - serializeAgentQueueProfile is the specialization-agnostic agent
 *     summary (profile data only, no Client data): capabilities omit a
 *     null level, a null location is omitted, and the shape is stable;
 *   - summarizeQueueVisit is the compact MKT-027 visit view: timestamps
 *     appear only when set, the follow-up link only when present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveJobObligations,
  serializeAgentQueueProfile,
  summarizeQueueVisit,
} from '../../src/api/jobs-queue-routes.ts';
import type {
  JobStatus,
  VisitRecord,
  VisitStatus,
} from '../../src/modules/jobs/public.ts';
import type { HumanAgentRecord } from '../../src/modules/field-agents/public.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function visit(id: string, status: VisitStatus): { visitId: string; status: VisitStatus } {
  return { visitId: id, status };
}

function agentProfile(overrides: Partial<HumanAgentRecord> = {}): HumanAgentRecord {
  return {
    agentId: '6f1f1111-1111-4111-8111-111111111111',
    userId: '6f1f2222-2222-4222-8222-222222222222',
    specializations: ['field_agent'],
    capabilities: [
      { skill: 'canvassing', level: 'advanced' },
      { skill: 'product_demo', level: null },
    ],
    availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }],
    location: { kind: 'city', value: 'accra' },
    territories: [
      { kind: 'city', value: 'accra' },
      { kind: 'region', value: 'greater accra' },
    ],
    reliability: {
      completedJobs: 0,
      successfulJobs: 0,
      onTimeCompletions: 0,
      ratingSum: 0,
      ratingCount: 0,
    },
    relationshipContinuity: {
      prefersRepeatClients: true,
      continuity: 'preferred',
      maxConcurrentClientRelationships: 4,
    },
    authorizationState: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

function visitRecord(overrides: Partial<VisitRecord> = {}): VisitRecord {
  return {
    visitId: '6f1f3333-3333-4333-8333-333333333333',
    jobId: '6f1f4444-4444-4444-8444-444444444444',
    visitSeq: 1,
    workspaceId: '6f1f5555-5555-4555-8555-555555555555',
    clientId: '6f1f6666-6666-4666-8666-666666666666',
    agencyId: '6f1f7777-7777-4777-8777-777777777777',
    targetIdentity: 'venue:osu-branch-42',
    status: 'planned',
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    followUpOfVisitId: null,
    createdBy: '6f1f2222-2222-4222-8222-222222222222',
    provenance: {
      actor: 'user:6f1f2222-2222-4222-8222-222222222222',
      recordedVia: 'api',
      correlationId: 'correlation-1',
      causationId: '6f1f4444-4444-4444-8444-444444444444',
      recordedAt: '2026-01-05T10:00:00.000Z',
    },
    version: 1,
    createdAt: '2026-01-05T10:00:00.000Z',
    updatedAt: '2026-01-05T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveJobObligations (UI-AC-01 — the authoritative obligation view)
// ---------------------------------------------------------------------------

test('job outcome is due exactly while the accepted job has no submitted outcome', () => {
  for (const jobStatus of ['projected', 'offered', 'declined', 'expired'] as JobStatus[]) {
    assert.equal(
      deriveJobObligations({
        jobStatus,
        hasJobOutcome: false,
        visits: [],
        evidenceCountByVisitId: new Map(),
      }).jobOutcomeDue,
      false,
      `${jobStatus} jobs are not the caller's execution obligation`,
    );
  }
  assert.equal(
    deriveJobObligations({
      jobStatus: 'accepted',
      hasJobOutcome: false,
      visits: [],
      evidenceCountByVisitId: new Map(),
    }).jobOutcomeDue,
    true,
    'an accepted job without an outcome report is due',
  );
  assert.equal(
    deriveJobObligations({
      jobStatus: 'outcome_submitted',
      hasJobOutcome: true,
      visits: [],
      evidenceCountByVisitId: new Map(),
    }).jobOutcomeDue,
    false,
    'a job with a submitted outcome is settled',
  );
  // Defensive posture: the durable outcome row wins even if the status
  // were ever stale.
  assert.equal(
    deriveJobObligations({
      jobStatus: 'accepted',
      hasJobOutcome: true,
      visits: [],
      evidenceCountByVisitId: new Map(),
    }).jobOutcomeDue,
    false,
    'a durable outcome row settles the obligation defensively',
  );
});

test('open visits are exactly the planned/in_progress ones', () => {
  const obligations = deriveJobObligations({
    jobStatus: 'accepted',
    hasJobOutcome: false,
    visits: [
      visit('a', 'planned'),
      visit('b', 'in_progress'),
      visit('c', 'completed'),
      visit('d', 'cancelled'),
    ],
    evidenceCountByVisitId: new Map([
      ['a', 0],
      ['b', 2],
    ]),
  });
  assert.deepEqual([...obligations.openVisitIds], ['a', 'b']);
});

test('evidence is due for in-progress visits with NO captured evidence (a missing count is zero — fail closed)', () => {
  const obligations = deriveJobObligations({
    jobStatus: 'accepted',
    hasJobOutcome: false,
    visits: [
      visit('planned-empty', 'planned'),
      visit('running-empty', 'in_progress'),
      visit('running-covered', 'in_progress'),
      visit('done-empty', 'completed'),
    ],
    evidenceCountByVisitId: new Map([
      ['running-covered', 3],
      ['done-empty', 0],
    ]),
  });
  assert.deepEqual(
    [...obligations.evidenceDueVisitIds],
    ['running-empty'],
    'only uncovered in-progress visits owe evidence (planned visits capture during execution)',
  );
});

test('deriveJobObligations is PURE — identical inputs produce identical outputs', () => {
  const input = {
    jobStatus: 'accepted' as JobStatus,
    hasJobOutcome: false,
    visits: [visit('a', 'planned'), visit('b', 'in_progress')],
    evidenceCountByVisitId: new Map<string, number>([['b', 0]]),
  };
  assert.deepEqual(deriveJobObligations(input), deriveJobObligations(input));
});

// ---------------------------------------------------------------------------
// serializeAgentQueueProfile (specialization-agnostic agent summary)
// ---------------------------------------------------------------------------

test('the agent summary carries profile data only — capabilities omit a null level, territories round-trip', () => {
  const summary = serializeAgentQueueProfile(agentProfile());
  assert.deepEqual(summary, {
    agentId: '6f1f1111-1111-4111-8111-111111111111',
    specializations: ['field_agent'],
    capabilities: [{ skill: 'canvassing', level: 'advanced' }, { skill: 'product_demo' }],
    availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }],
    location: { kind: 'city', value: 'accra' },
    territories: [
      { kind: 'city', value: 'accra' },
      { kind: 'region', value: 'greater accra' },
    ],
    authorizationState: 'active',
  });
  const serialized = JSON.stringify(summary);
  for (const forbidden of ['clientId', 'agencyId', 'workspaceId', 'reliability']) {
    assert.ok(
      !serialized.includes(`"${forbidden}"`),
      `the agent summary must not carry '${forbidden}'`,
    );
  }
});

test('a null location is omitted from the agent summary; the shape is stable for every specialization', () => {
  const summary = serializeAgentQueueProfile(
    agentProfile({
      specializations: ['chatter'],
      location: null,
      territories: [],
    }),
  );
  assert.ok(!('location' in summary), 'a null location key is absent');
  assert.deepEqual(summary['territories'], []);
  // Specialization-agnostic: the same shape for a non-field specialization.
  assert.deepEqual(summary['specializations'], ['chatter']);
});

// ---------------------------------------------------------------------------
// summarizeQueueVisit (the compact MKT-027 visit view)
// ---------------------------------------------------------------------------

test('the visit summary carries the obligation coordinates; timestamps appear only when set', () => {
  const summary = summarizeQueueVisit(visitRecord());
  assert.deepEqual(summary, {
    visitId: '6f1f3333-3333-4333-8333-333333333333',
    visitSeq: 1,
    targetIdentity: 'venue:osu-branch-42',
    status: 'planned',
  });

  const running = summarizeQueueVisit(
    visitRecord({
      status: 'in_progress',
      startedAt: '2026-01-06T08:05:00.000Z',
      followUpOfVisitId: '6f1f8888-8888-4888-8888-888888888888',
    }),
  );
  assert.deepEqual(running, {
    visitId: '6f1f3333-3333-4333-8333-333333333333',
    visitSeq: 1,
    targetIdentity: 'venue:osu-branch-42',
    status: 'in_progress',
    startedAt: '2026-01-06T08:05:00.000Z',
    followUpOfVisitId: '6f1f8888-8888-4888-8888-888888888888',
  });

  // No scope leakage: the compact view never carries the tenant scope keys.
  const serialized = JSON.stringify(running);
  for (const forbidden of ['workspaceId', 'clientId', 'agencyId', 'provenance']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `the visit summary must not carry '${forbidden}'`);
  }
});
