/**
 * MKT-025 unit tests — the frozen Human Agent model as PURE functions
 * (spec/human-agent-v1.3.md; requirements FIELD-001 + HUMAN-001).
 *
 * Proofs:
 *   - HUMAN_SPECIALIZATIONS is exactly the frozen registry of
 *     human-agent-v1.3.md §2 + HUMAN-AC-02 (+ Sales Agent): Field Agent,
 *     Chatter, Creator Manager, Content Manager, Growth Manager, Account
 *     Manager, Reviewer, Sales Agent — capability metadata of the ONE
 *     generic profile, never a second execution model;
 *   - HUMAN_AUTHORIZATION_TRANSITIONS is exactly the frozen
 *     active/suspended/contract_ended lifecycle with contract_ended
 *     TERMINAL (contract history cannot be rewritten) and NO execution
 *     semantics (no job/offer/acceptance states — HUMAN-AC-02);
 *   - validateHumanAgentDeclaration (the profile validation contract)
 *     accepts a complete HUMAN-AC-01 declaration and rejects every
 *     malformed variant: unknown/duplicate specializations, empty/invalid
 *     capabilities, malformed availability windows, invalid territories,
 *     invalid relationship continuity, and the Field-Agent geography rule;
 *   - isAgentEligibleForJob (the FIELD-AC-02 pure matcher) matches only on
 *     authorization state, specialization, required capabilities,
 *     territory and availability-window overlap — and is PURE (identical
 *     inputs → identical outputs);
 *   - the reliability fold is a pure server-side aggregate (never an
 *     authority input).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_LEVELS,
  EMPTY_RELIABILITY_SIGNALS,
  HUMAN_AUTHORIZATION_TRANSITIONS,
  HUMAN_SPECIALIZATIONS,
  HUMAN_SPECIALIZATION_KEYS,
  applyReliabilityObservation,
  availabilityCovers,
  isAgentEligibleForJob,
  isHumanSpecialization,
  isLegalAuthorizationTransition,
  territoryMatches,
  validateHumanAgentDeclaration,
  validateReliabilityObservation,
  type AvailabilityWindow,
  type HumanAgentDeclaration,
  type HumanAgentRecord,
  type JobEligibilitySpec,
  type ReliabilityObservation,
  type Territory,
} from '../../src/modules/field-agents/public.ts';

// ---------------------------------------------------------------------------
// Specialization model (HUMAN-AC-02, human-agent-v1.3.md §2)
// ---------------------------------------------------------------------------

test('HUMAN_SPECIALIZATIONS is exactly the frozen v1.3 registry (capability metadata, not models)', () => {
  assert.deepEqual([...HUMAN_SPECIALIZATIONS].sort(), [
    'account_manager',
    'chatter',
    'content_manager',
    'creator_manager',
    'field_agent',
    'growth_manager',
    'reviewer',
    'sales_agent',
  ]);
  assert.equal(HUMAN_SPECIALIZATION_KEYS.length, 8);
  for (const specialization of HUMAN_SPECIALIZATION_KEYS) {
    assert.equal(isHumanSpecialization(specialization), true);
  }
  assert.equal(isHumanSpecialization('field_ops'), false);
  assert.equal(isHumanSpecialization('FieldAgent'), false);
  assert.equal(isHumanSpecialization(''), false);
});

test('every specialization is a TAG on the same generic profile — no per-specialization model exists', () => {
  // The registry is flat strings: there is exactly ONE declaration shape
  // (HumanAgentDeclaration) consumed by every specialization — a
  // specialization adds no second execution system (HUMAN-AC-02).
  assert.ok(
    HUMAN_SPECIALIZATION_KEYS.every((specialization) => typeof specialization === 'string'),
  );
});

// ---------------------------------------------------------------------------
// Authorization/contract lifecycle (HUMAN-AC-01)
// ---------------------------------------------------------------------------

test('HUMAN_AUTHORIZATION_TRANSITIONS is exactly the frozen authorization/contract machine', () => {
  assert.deepEqual([...Object.keys(HUMAN_AUTHORIZATION_TRANSITIONS)].sort(), [
    'active',
    'contract_ended',
    'suspended',
  ]);
  assert.deepEqual([...HUMAN_AUTHORIZATION_TRANSITIONS.active].sort(), [
    'contract_ended',
    'suspended',
  ]);
  assert.deepEqual([...HUMAN_AUTHORIZATION_TRANSITIONS.suspended].sort(), [
    'active',
    'contract_ended',
  ]);
  assert.deepEqual([...HUMAN_AUTHORIZATION_TRANSITIONS.contract_ended], []);
});

test('contract_ended is terminal — no resurrection out of ended contracts', () => {
  for (const target of ['active', 'suspended', 'contract_ended'] as const) {
    assert.equal(
      isLegalAuthorizationTransition('contract_ended', target),
      false,
      `contract_ended → ${target} must be illegal (terminal contract history)`,
    );
  }
});

test('the legal authorization transitions are exactly the frozen set (and carry NO execution semantics)', () => {
  const legal: ReadonlyArray<[string, string]> = [
    ['active', 'suspended'],
    ['active', 'contract_ended'],
    ['suspended', 'active'],
    ['suspended', 'contract_ended'],
  ];
  const all = ['active', 'suspended', 'contract_ended'] as const;
  for (const from of all) {
    for (const to of all) {
      const expected = legal.some(([f, t]) => f === from && t === to);
      assert.equal(
        isLegalAuthorizationTransition(from, to),
        expected,
        `${from} → ${to} legality must be ${expected}`,
      );
    }
  }
  // No job/execution/offer states anywhere in the profile lifecycle.
  const machine = Object.keys(HUMAN_AUTHORIZATION_TRANSITIONS).join(' ').toLowerCase();
  for (const forbidden of ['offered', 'accepted', 'queued', 'running', 'dispatched', 'in_progress']) {
    assert.equal(machine.includes(forbidden), false);
  }
});

// ---------------------------------------------------------------------------
// Profile validation contract (HUMAN-AC-01 shape)
// ---------------------------------------------------------------------------

const VALID_DECLARATION: HumanAgentDeclaration = {
  specializations: ['field_agent'],
  capabilities: [
    { skill: 'canvassing', level: 'advanced' },
    { skill: 'product_demo', level: null },
  ],
  availability: [
    { dayOfWeek: 1, startMinute: 540, endMinute: 1020 },
    { dayOfWeek: 3, startMinute: 600, endMinute: 900 },
  ],
  location: { kind: 'city', value: 'accra' },
  territories: [
    { kind: 'city', value: 'accra' },
    { kind: 'region', value: 'greater accra' },
  ],
  relationshipContinuity: {
    prefersRepeatClients: true,
    continuity: 'preferred',
    maxConcurrentClientRelationships: 4,
  },
};

test('a complete HUMAN-AC-01 declaration validates cleanly', () => {
  assert.deepEqual([...validateHumanAgentDeclaration(VALID_DECLARATION)], []);
});

test('profile validation rejects unknown, duplicate and empty specializations', () => {
  const unknown = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    // Runtime-smuggled unknown tag (typed as never on purpose: the pure
    // validator must reject values outside the frozen registry).
    specializations: ['field_agent', 'chatter', 'influencer'] as never,
  });
  assert.ok(unknown.some((problem) => problem.includes("unknown specialization 'influencer'")));

  const duplicate = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    specializations: ['field_agent', 'field_agent'],
  });
  assert.ok(duplicate.some((problem) => problem.includes("duplicate entry 'field_agent'")));

  const empty = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    specializations: [],
  });
  assert.ok(empty.some((problem) => problem.includes('specializations: must contain')));
});

test('profile validation rejects empty, malformed and duplicate capabilities', () => {
  assert.ok(
    validateHumanAgentDeclaration({
      ...VALID_DECLARATION,
      capabilities: [],
    }).some((problem) => problem.includes('capabilities: must contain')),
  );
  assert.ok(
    validateHumanAgentDeclaration({
      ...VALID_DECLARATION,
      capabilities: [
        { skill: 'Canvassing', level: null },
        { skill: 'canvassing', level: null },
      ],
    }).some((problem) => problem.includes("not a valid normalized skill tag")),
  );
  assert.ok(
    validateHumanAgentDeclaration({
      ...VALID_DECLARATION,
      capabilities: [
        { skill: 'canvassing', level: null },
        { skill: 'canvassing', level: 'expert' },
      ],
    }).some((problem) => problem.includes("duplicate skill 'canvassing'")),
  );
  assert.ok(
    validateHumanAgentDeclaration({
      ...VALID_DECLARATION,
      capabilities: [{ skill: 'canvassing', level: 'master' as never }],
    }).some((problem) => problem.includes('not a valid proficiency level')),
  );
  assert.deepEqual([...CAPABILITY_LEVELS], ['beginner', 'intermediate', 'advanced', 'expert']);
});

test('profile validation rejects malformed availability windows', () => {
  const dayOutOfRange = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    availability: [{ dayOfWeek: 7, startMinute: 540, endMinute: 1020 }],
  });
  assert.ok(dayOutOfRange.some((problem) => problem.includes('dayOfWeek must be an integer 0')));

  const reversedWindow = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    availability: [{ dayOfWeek: 1, startMinute: 900, endMinute: 540 }],
  });
  assert.ok(reversedWindow.some((problem) => problem.includes('startMinute must be before endMinute')));

  const emptyWindows = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    availability: [],
  });
  assert.ok(emptyWindows.some((problem) => problem.includes('availability: must contain')));

  const duplicateWindows = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    availability: [
      { dayOfWeek: 1, startMinute: 540, endMinute: 1020 },
      { dayOfWeek: 1, startMinute: 540, endMinute: 1020 },
    ],
  });
  assert.ok(duplicateWindows.some((problem) => problem.includes('duplicate window')));
});

test('profile validation rejects malformed territories', () => {
  const badKind = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    territories: [{ kind: 'continent' as never, value: 'africa' }],
  });
  assert.ok(badKind.some((problem) => problem.includes('not a valid territory kind')));

  const badValue = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    territories: [{ kind: 'city', value: '!invalid!' }],
  });
  assert.ok(badValue.some((problem) => problem.includes('territory value must be')));

  const duplicates = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    territories: [
      { kind: 'city', value: 'accra' },
      { kind: 'city', value: 'accra' },
    ],
  });
  assert.ok(duplicates.some((problem) => problem.includes("duplicate entry 'accra'")));
});

test('profile validation rejects malformed relationship continuity', () => {
  assert.ok(
    validateHumanAgentDeclaration({
      ...VALID_DECLARATION,
      relationshipContinuity: {
        prefersRepeatClients: 'yes' as never,
        continuity: 'preferred',
        maxConcurrentClientRelationships: null,
      },
    }).some((problem) => problem.includes('prefersRepeatClients must be a boolean')),
  );
  assert.ok(
    validateHumanAgentDeclaration({
      ...VALID_DECLARATION,
      relationshipContinuity: {
        prefersRepeatClients: true,
        continuity: 'always' as never,
        maxConcurrentClientRelationships: null,
      },
    }).some((problem) => problem.includes('not a valid continuity mode')),
  );
  assert.ok(
    validateHumanAgentDeclaration({
      ...VALID_DECLARATION,
      relationshipContinuity: {
        prefersRepeatClients: true,
        continuity: 'preferred',
        maxConcurrentClientRelationships: 0,
      },
    }).some((problem) => problem.includes('maxConcurrentClientRelationships must be null or an integer 1..100')),
  );
});

test('the Field Agent specialization requires declared geography (FIELD-AC-01 rule)', () => {
  const noGeography = validateHumanAgentDeclaration({
    ...VALID_DECLARATION,
    location: null,
    territories: [],
  });
  assert.ok(
    noGeography.some((problem) =>
      problem.includes('field_agent specialization requires a declared location or at least one territory'),
    ),
  );

  // A territory alone (no current location) satisfies the rule.
  assert.deepEqual(
    [
      ...validateHumanAgentDeclaration({
        ...VALID_DECLARATION,
        location: null,
        territories: [{ kind: 'city', value: 'accra' }],
      }),
    ],
    [],
  );

  // A location alone (no service territories) satisfies the rule.
  assert.deepEqual(
    [
      ...validateHumanAgentDeclaration({
        ...VALID_DECLARATION,
        location: { kind: 'city', value: 'accra' },
        territories: [],
      }),
    ],
    [],
  );

  // Non-field specializations do NOT require geography (optional territories).
  assert.deepEqual(
    [
      ...validateHumanAgentDeclaration({
        ...VALID_DECLARATION,
        specializations: ['chatter'],
        location: null,
        territories: [],
      }),
    ],
    [],
  );
});

// ---------------------------------------------------------------------------
// The pure eligibility matcher (FIELD-AC-02)
// ---------------------------------------------------------------------------

function agentRecord(overrides: Partial<HumanAgentRecord>): HumanAgentRecord {
  return {
    agentId: 'agent-1',
    userId: 'user-1',
    specializations: ['field_agent'],
    capabilities: [
      { skill: 'canvassing', level: 'advanced' },
      { skill: 'product_demo', level: null },
    ],
    availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
    location: { kind: 'city', value: 'accra' },
    territories: [{ kind: 'region', value: 'greater accra' }],
    reliability: { ...EMPTY_RELIABILITY_SIGNALS },
    relationshipContinuity: {
      prefersRepeatClients: true,
      continuity: 'preferred',
      maxConcurrentClientRelationships: null,
    },
    authorizationState: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const BASE_SPEC: JobEligibilitySpec = {
  specialization: 'field_agent',
  requiredCapabilities: ['canvassing'],
  territory: { kind: 'city', value: 'accra' },
  availability: { dayOfWeek: 1, startMinute: 600, endMinute: 720 },
};

test('the matcher matches a fully-eligible profile', () => {
  assert.equal(isAgentEligibleForJob(agentRecord({}), BASE_SPEC), true);
});

test('suspended and contract-ended agents are never eligible', () => {
  assert.equal(isAgentEligibleForJob(agentRecord({ authorizationState: 'suspended' }), BASE_SPEC), false);
  assert.equal(
    isAgentEligibleForJob(agentRecord({ authorizationState: 'contract_ended' }), BASE_SPEC),
    false,
  );
});

test('a missing specialization or required capability breaks eligibility', () => {
  assert.equal(
    isAgentEligibleForJob(agentRecord({ specializations: ['chatter', 'reviewer'] }), BASE_SPEC),
    false,
  );
  assert.equal(
    isAgentEligibleForJob(
      agentRecord({ capabilities: [{ skill: 'product_demo', level: null }] }),
      BASE_SPEC,
    ),
    false,
  );
  // No required capabilities → capability set is not a gate.
  assert.equal(
    isAgentEligibleForJob(agentRecord({}), { ...BASE_SPEC, requiredCapabilities: [] }),
    true,
  );
});

test('territory matching is exact (kind AND value), via location OR territories', () => {
  // Exact match via location.
  assert.equal(isAgentEligibleForJob(agentRecord({}), BASE_SPEC), true);
  // Exact match via the territories list.
  assert.equal(
    isAgentEligibleForJob(
      agentRecord({ location: { kind: 'city', value: 'kumasi' } }),
      { ...BASE_SPEC, territory: { kind: 'region', value: 'greater accra' } },
    ),
    true,
  );
  // Different value, same kind → no match (no invented hierarchy).
  assert.equal(
    isAgentEligibleForJob(agentRecord({}), {
      ...BASE_SPEC,
      territory: { kind: 'city', value: 'kumasi' },
    }),
    false,
  );
  // Different kind, same value → no match.
  assert.equal(
    isAgentEligibleForJob(agentRecord({}), {
      ...BASE_SPEC,
      territory: { kind: 'region', value: 'accra' },
    }),
    false,
  );
  // No territory requirement → geography is ignored.
  assert.equal(
    isAgentEligibleForJob(
      agentRecord({ location: null, territories: [] as Territory[] }),
      { ...BASE_SPEC, territory: null },
    ),
    true,
  );
});

test('availability matching requires same-day window OVERLAP (end-exclusive)', () => {
  // Contained overlap.
  assert.equal(
    isAgentEligibleForJob(agentRecord({}), {
      ...BASE_SPEC,
      availability: { dayOfWeek: 1, startMinute: 700, endMinute: 800 },
    }),
    true,
  );
  // Adjacent, non-overlapping (agent window ends exactly when job starts).
  assert.equal(
    isAgentEligibleForJob(agentRecord({}), {
      ...BASE_SPEC,
      availability: { dayOfWeek: 1, startMinute: 1020, endMinute: 1200 },
    }),
    false,
  );
  // Partial overlap at the boundary minute.
  assert.equal(
    isAgentEligibleForJob(agentRecord({}), {
      ...BASE_SPEC,
      availability: { dayOfWeek: 1, startMinute: 500, endMinute: 541 },
    }),
    true,
  );
  // Different day → no match.
  assert.equal(
    isAgentEligibleForJob(agentRecord({}), {
      ...BASE_SPEC,
      availability: { dayOfWeek: 2, startMinute: 600, endMinute: 720 },
    }),
    false,
  );
});

test('the matcher is PURE: identical inputs produce identical outputs', () => {
  const first = isAgentEligibleForJob(agentRecord({}), BASE_SPEC);
  const second = isAgentEligibleForJob(agentRecord({}), BASE_SPEC);
  assert.equal(first, second);
  const record = agentRecord({});
  isAgentEligibleForJob(record, BASE_SPEC);
  isAgentEligibleForJob(record, { ...BASE_SPEC, territory: null });
  assert.deepEqual(record, agentRecord({}), 'the matcher never mutates its input');
});

test('territoryMatches and availabilityCovers are exact helpers', () => {
  assert.equal(territoryMatches({ kind: 'city', value: 'accra' }, { kind: 'city', value: 'accra' }), true);
  assert.equal(territoryMatches({ kind: 'city', value: 'accra' }, { kind: 'city', value: 'ACCRA' }), false);
  const window: AvailabilityWindow = { dayOfWeek: 1, startMinute: 540, endMinute: 1020 };
  assert.equal(availabilityCovers(window, { dayOfWeek: 1, startMinute: 600, endMinute: 700 }), true);
  assert.equal(availabilityCovers(window, { dayOfWeek: 1, startMinute: 1020, endMinute: 1100 }), false);
  assert.equal(availabilityCovers(window, { dayOfWeek: 3, startMinute: 600, endMinute: 700 }), false);
});

// ---------------------------------------------------------------------------
// Server-derived reliability fold (HUMAN-AC-01 quality signals)
// ---------------------------------------------------------------------------

test('the reliability fold is a pure aggregate over server-side observations', () => {
  const observation: ReliabilityObservation = { outcome: 'succeeded', onTime: true, rating: 4 };
  const next = applyReliabilityObservation(EMPTY_RELIABILITY_SIGNALS, observation);
  assert.deepEqual(next, {
    completedJobs: 1,
    successfulJobs: 1,
    onTimeCompletions: 1,
    ratingSum: 4,
    ratingCount: 1,
  });
  assert.deepEqual(EMPTY_RELIABILITY_SIGNALS, {
    completedJobs: 0,
    successfulJobs: 0,
    onTimeCompletions: 0,
    ratingSum: 0,
    ratingCount: 0,
  });
  const failedLate = applyReliabilityObservation(next, {
    outcome: 'failed',
    onTime: false,
    rating: null,
  });
  assert.deepEqual(failedLate, {
    completedJobs: 2,
    successfulJobs: 1,
    onTimeCompletions: 1,
    ratingSum: 4,
    ratingCount: 1,
  });
  // Purity: the input aggregate is never mutated.
  assert.deepEqual(next, {
    completedJobs: 1,
    successfulJobs: 1,
    onTimeCompletions: 1,
    ratingSum: 4,
    ratingCount: 1,
  });
});

test('reliability observations validate their server-side shape (outcome/onTime/rating)', () => {
  assert.deepEqual(
    [...validateReliabilityObservation({ outcome: 'succeeded', onTime: true, rating: null })],
    [],
  );
  assert.ok(
    validateReliabilityObservation({
      outcome: 'maybe' as never,
      onTime: true,
      rating: null,
    }).some((problem) => problem.includes('outcome')),
  );
  assert.ok(
    validateReliabilityObservation({
      outcome: 'succeeded',
      onTime: 'yes' as never,
      rating: null,
    }).some((problem) => problem.includes('onTime')),
  );
  assert.ok(
    validateReliabilityObservation({ outcome: 'succeeded', onTime: true, rating: 6 }).some(
      (problem) => problem.includes('rating'),
    ),
  );
});
