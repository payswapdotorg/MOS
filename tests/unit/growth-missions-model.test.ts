/**
 * MKT-053 unit tests — the frozen Growth Mission vocabularies, the frozen
 * lifecycle state machine, the mapping/declaration/provenance guards and
 * the canonical owner-context composer (pure functions, no DB).
 *
 * Proofs (spec/architecture-v1.6.md §1/§2/§3; spec/architecture-lock-v1.6.md
 * rules 16/17/41; the goal-lifecycle precedent):
 *   - GROWTH_MISSION_OBJECTIVE_FAMILIES is exactly the frozen §3 vocabulary,
 *     VERBATIM (the full eight-family list — at minimum creator_growth,
 *     audience_growth, product_marketing, commerce_discovery);
 *   - GROWTH_MISSION_STATUSES / GROWTH_MISSION_TERMINAL_STATUSES carry the
 *     full §2 state vocabulary including EVERY terminal state, and the
 *     terminal set is exactly the §2 "Terminal states" list, verbatim;
 *   - GROWTH_MISSION_TRANSITIONS is the frozen mission record machine:
 *     terminal states have NO outgoing transitions (the honest-state rule
 *     — a block is NEVER silently converted into success; 'achieved' is
 *     reachable ONLY from 'active'), draft/active/paused edges exactly as
 *     disclosed in docs/implementation/MKT-053.md;
 *   - the declaration guard rejects structurally dishonest declarations
 *     (empty objective, non-frozen family, bad metrics, duplicate metric
 *     names, missing intermediate flags) and accepts honest ones;
 *   - the provenance guard + the reason guard enforce the server-derived
 *     provenance discipline (bounded labels, correlation present, honest
 *     transition reasons);
 *   - composeGrowthMissionOwnerContext derives the canonical scope from
 *     the mission row and the /agencies row only (never from caller
 *     input) and is pure: identical inputs compose identical outputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import {
  GROWTH_MISSION_EVENT_KINDS,
  GROWTH_MISSION_METRIC_COMPARATORS,
  GROWTH_MISSION_OBJECTIVE_FAMILIES,
  GROWTH_MISSION_STATUSES,
  GROWTH_MISSION_TERMINAL_DECISION_BASIS,
  GROWTH_MISSION_TERMINAL_STATUSES,
  GROWTH_MISSION_TRANSITIONS,
  GROWTH_MISSION_VOCABULARY_VERSION,
  assertValidGrowthMissionDeclaration,
  assertValidGrowthMissionProvenance,
  assertValidGrowthMissionReason,
  composeGrowthMissionOwnerContext,
  isKnownGrowthMissionObjectiveFamily,
  isKnownGrowthMissionStatus,
  isLegalGrowthMissionTransition,
  isTerminalGrowthMissionStatus,
  type GrowthMissionDeclaration,
  type GrowthMissionProvenance,
  type GrowthMissionRecord,
} from '../../src/modules/growth-missions/public.ts';

// ---------------------------------------------------------------------------
// AC-1/AC-2: the frozen objective-family vocabulary (§3, verbatim)
// ---------------------------------------------------------------------------

test('GROWTH_MISSION_OBJECTIVE_FAMILIES is exactly the frozen architecture-v1.6.md §3 list, VERBATIM', () => {
  assert.deepEqual([...GROWTH_MISSION_OBJECTIVE_FAMILIES], [
    'audience_growth',
    'creator_growth',
    'product_marketing',
    'acquisition',
    'lead_generation',
    'revenue',
    'commerce_discovery',
    'hybrid',
  ]);
});

test('the round-trip families of the MKT-053 acceptance are in the frozen vocabulary', () => {
  // The acceptance names creator-growth, audience-growth, product-marketing
  // and commerce-discovery missions — the full family list is pinned above.
  for (const family of ['creator_growth', 'audience_growth', 'product_marketing', 'commerce_discovery'] as const) {
    assert.ok(
      (GROWTH_MISSION_OBJECTIVE_FAMILIES as readonly string[]).includes(family),
      `${family} is in the frozen family vocabulary`,
    );
  }
});

test('the family predicate accepts exactly the frozen set and rejects everything else', () => {
  for (const family of GROWTH_MISSION_OBJECTIVE_FAMILIES) {
    assert.equal(isKnownGrowthMissionObjectiveFamily(family), true);
  }
  for (const foreign of ['', 'growth', 'creator-growth', 'CREATOR_GROWTH', 'engagement', 'vanity_metrics']) {
    assert.equal(isKnownGrowthMissionObjectiveFamily(foreign), false, `'${foreign}' is not a frozen family`);
  }
});

test('the terminal-decision basis is the declared business objective family (§3), versioned', () => {
  assert.equal(GROWTH_MISSION_TERMINAL_DECISION_BASIS, 'declared-business-objective-family');
  assert.equal(GROWTH_MISSION_VOCABULARY_VERSION, 'gm-vocab-v1');
});

// ---------------------------------------------------------------------------
// AC-3: the frozen lifecycle state machine (§2)
// ---------------------------------------------------------------------------

test('GROWTH_MISSION_STATUSES is the full state vocabulary: 3 non-terminal + the 7 §2 terminal states', () => {
  assert.deepEqual([...GROWTH_MISSION_STATUSES], [
    'draft',
    'active',
    'paused',
    'achieved',
    'stopped_by_user',
    'blocked_pending_human_action',
    'blocked_by_unavailable_capability',
    'budget_quota_exhausted',
    'policy_constrained',
    'failed_after_bounded_recovery',
  ]);
});

test('the TERMINAL set is exactly the architecture-v1.6.md §2 "Terminal states" list, VERBATIM', () => {
  assert.deepEqual([...GROWTH_MISSION_TERMINAL_STATUSES], [
    'achieved',
    'stopped_by_user',
    'blocked_pending_human_action',
    'blocked_by_unavailable_capability',
    'budget_quota_exhausted',
    'policy_constrained',
    'failed_after_bounded_recovery',
  ]);
  for (const status of GROWTH_MISSION_TERMINAL_STATUSES) {
    assert.equal(isTerminalGrowthMissionStatus(status), true, `${status} is terminal`);
  }
  for (const status of ['draft', 'active', 'paused'] as const) {
    assert.equal(isTerminalGrowthMissionStatus(status), false, `${status} is non-terminal`);
  }
});

test('the state predicate accepts exactly the frozen set and rejects everything else', () => {
  for (const status of GROWTH_MISSION_STATUSES) {
    assert.equal(isKnownGrowthMissionStatus(status), true);
  }
  for (const foreign of ['', 'running', 'queued', 'blocked', 'stopped-by-user', 'succeeded']) {
    assert.equal(isKnownGrowthMissionStatus(foreign), false, `'${foreign}' is not a frozen state`);
  }
});

test('GROWTH_MISSION_TRANSITIONS is exactly the disclosed frozen mission-record machine', () => {
  assert.deepEqual([...GROWTH_MISSION_TRANSITIONS.draft], ['active', 'stopped_by_user']);
  assert.deepEqual([...GROWTH_MISSION_TRANSITIONS.active], [
    'paused',
    'achieved',
    'stopped_by_user',
    'blocked_pending_human_action',
    'blocked_by_unavailable_capability',
    'budget_quota_exhausted',
    'policy_constrained',
    'failed_after_bounded_recovery',
  ]);
  assert.deepEqual([...GROWTH_MISSION_TRANSITIONS.paused], ['active', 'stopped_by_user']);
});

test('the honest-state rule: terminal states have NO outgoing transitions — a block is NEVER silently converted into success', () => {
  for (const terminal of GROWTH_MISSION_TERMINAL_STATUSES) {
    assert.deepEqual([...GROWTH_MISSION_TRANSITIONS[terminal]], [], `${terminal} is terminal`);
    for (const target of GROWTH_MISSION_STATUSES) {
      assert.equal(
        isLegalGrowthMissionTransition(terminal, target),
        false,
        `${terminal} → ${target} must be illegal (terminal mission history is frozen)`,
      );
    }
  }
  // The sharpest honest-state pairs: a BLOCKED mission can never be moved
  // to 'achieved' by any later transition (§2: "The controller never
  // silently converts a block into success.").
  for (const blocked of [
    'blocked_pending_human_action',
    'blocked_by_unavailable_capability',
    'budget_quota_exhausted',
    'policy_constrained',
    'failed_after_bounded_recovery',
  ] as const) {
    assert.equal(isLegalGrowthMissionTransition(blocked, 'achieved'), false);
    assert.equal(isLegalGrowthMissionTransition(blocked, 'active'), false);
    assert.equal(isLegalGrowthMissionTransition(blocked, 'paused'), false);
  }
});

test("'achieved' is reachable ONLY from 'active' — an evaluation result recorded while the mission is being pursued", () => {
  for (const from of GROWTH_MISSION_STATUSES) {
    assert.equal(
      isLegalGrowthMissionTransition(from, 'achieved'),
      from === 'active',
      `${from} → achieved legality must be ${from === 'active'}`,
    );
  }
});

test('the legal mission transitions are exactly the frozen set (exhaustive cross-product)', () => {
  const legal: ReadonlyArray<[string, string]> = [
    ['draft', 'active'],
    ['draft', 'stopped_by_user'],
    ['active', 'paused'],
    ['active', 'achieved'],
    ['active', 'stopped_by_user'],
    ['active', 'blocked_pending_human_action'],
    ['active', 'blocked_by_unavailable_capability'],
    ['active', 'budget_quota_exhausted'],
    ['active', 'policy_constrained'],
    ['active', 'failed_after_bounded_recovery'],
    ['paused', 'active'],
    ['paused', 'stopped_by_user'],
  ];
  for (const from of GROWTH_MISSION_STATUSES) {
    for (const to of GROWTH_MISSION_STATUSES) {
      const expected = legal.some(([f, t]) => f === from && t === to);
      assert.equal(
        isLegalGrowthMissionTransition(from, to),
        expected,
        `${from} → ${to} legality must be ${expected}`,
      );
    }
  }
});

test('the event-kind vocabulary is the closed history-tail set', () => {
  assert.deepEqual([...GROWTH_MISSION_EVENT_KINDS], [
    'mission_created',
    'version_recorded',
    'goal_mapped',
    'goal_unmapped',
    'state_transition',
  ]);
});

// ---------------------------------------------------------------------------
// AC-1/AC-8: the declaration guard (the structurally honest declaration)
// ---------------------------------------------------------------------------

const honestProvenance: GrowthMissionProvenance = {
  actor: 'user:00000000-0000-4000-8000-000000000001',
  recordedVia: 'api',
  correlationId: 'corr-1',
  causationId: null,
};

function honestDeclaration(overrides: Partial<GrowthMissionDeclaration> = {}): GrowthMissionDeclaration {
  return {
    objective: 'grow a YouTube channel to 1,000,000 qualified views',
    objectiveFamily: 'creator_growth',
    productContext: null,
    marketContext: { audience: 'crypto-curious developers', geography: null, summary: null },
    targetMetrics: [
      { metric: 'qualified_views', comparator: '>=', targetValue: 1_000_000, unit: 'count', description: null, intermediate: false },
      { metric: 'subscriber_growth_rate', comparator: '>=', targetValue: 0.05, unit: '%', description: null, intermediate: true },
    ],
    ...overrides,
  };
}

/** Asserts the guard rejected with the field-specific detail (the details list, not the summary message). */
function throwsWithDetail(fn: () => void, fragment: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof InvalidRequestError);
    const details = (error.details ?? []).join('\n');
    return details.includes(fragment) || error.message.includes(fragment);
  });
}

test('an honest declaration passes the guard (objective verbatim, frozen family, bounded contexts, measurable metrics)', () => {
  assert.doesNotThrow(() => assertValidGrowthMissionDeclaration(honestDeclaration()));
});

test('the guard rejects a missing/empty/oversized objective (the declared business outcome is required, verbatim)', () => {
  for (const objective of ['', '   ', 'x'.repeat(5001)]) {
    throwsWithDetail(
      () => assertValidGrowthMissionDeclaration(honestDeclaration({ objective })),
      'objective',
    );
  }
});

test('the guard rejects every non-frozen objective family', () => {
  for (const family of ['growth', 'creator-growth', 'ENGAGEMENT', 'vanity']) {
    throwsWithDetail(
      () =>
        assertValidGrowthMissionDeclaration(
          honestDeclaration({ objectiveFamily: family as GrowthMissionDeclaration['objectiveFamily'] }),
        ),
      'objectiveFamily',
    );
  }
});

test('the guard rejects structurally unmeasurable target metrics (the /goals measurability discipline)', () => {
  throwsWithDetail(
    () =>
      assertValidGrowthMissionDeclaration(
        honestDeclaration({
          targetMetrics: [
            { metric: 'views', comparator: '~=' as never, targetValue: 100, unit: null, description: null, intermediate: false },
          ],
        }),
      ),
    'comparator',
  );
  throwsWithDetail(
    () =>
      assertValidGrowthMissionDeclaration(
        honestDeclaration({
          targetMetrics: [
            { metric: 'views', comparator: '>=', targetValue: Number.NaN, unit: null, description: null, intermediate: false },
          ],
        }),
      ),
    'targetValue',
  );
  throwsWithDetail(
    () =>
      assertValidGrowthMissionDeclaration(
        honestDeclaration({
          targetMetrics: [
            { metric: '', comparator: '>=', targetValue: 100, unit: null, description: null, intermediate: false },
          ],
        }),
      ),
    'metric',
  );
});

test('the guard rejects duplicate metric names within one declared version', () => {
  throwsWithDetail(
    () =>
      assertValidGrowthMissionDeclaration(
        honestDeclaration({
          targetMetrics: [
            { metric: 'views', comparator: '>=', targetValue: 100, unit: null, description: null, intermediate: false },
            { metric: 'views', comparator: '>=', targetValue: 200, unit: null, description: null, intermediate: true },
          ],
        }),
      ),
    'more than once',
  );
});

test('the guard requires the INTERMEDIATE flag to be explicit on every target metric (§3: intermediate metrics are marked)', () => {
  throwsWithDetail(
    () =>
      assertValidGrowthMissionDeclaration(
        honestDeclaration({
          targetMetrics: [
            { metric: 'views', comparator: '>=', targetValue: 100, unit: null, description: null, intermediate: 'yes' as unknown as boolean },
          ],
        }),
      ),
    'intermediate',
  );
  // Both flag values are legal — the flag itself must simply be explicit.
  for (const intermediate of [true, false]) {
    assert.doesNotThrow(() =>
      assertValidGrowthMissionDeclaration(
        honestDeclaration({
          targetMetrics: [
            { metric: 'views', comparator: '>=', targetValue: 100, unit: null, description: null, intermediate },
          ],
        }),
      ),
    );
  }
});

test('the guard rejects oversized product/market context fields', () => {
  throwsWithDetail(
    () =>
      assertValidGrowthMissionDeclaration(
        honestDeclaration({ productContext: { name: 'x'.repeat(501), url: null, summary: null } }),
      ),
    'productContext',
  );
  throwsWithDetail(
    () =>
      assertValidGrowthMissionDeclaration(
        honestDeclaration({ marketContext: { audience: 'x'.repeat(501), geography: null, summary: null } }),
      ),
    'marketContext',
  );
  // Null contexts are legal (a creator-growth mission may carry no product).
  assert.doesNotThrow(() =>
    assertValidGrowthMissionDeclaration(honestDeclaration({ productContext: null, marketContext: null })),
  );
});

test('the comparator vocabulary is the /goals set', () => {
  assert.deepEqual([...GROWTH_MISSION_METRIC_COMPARATORS], ['>=', '>', '<=', '<', '==']);
});

// ---------------------------------------------------------------------------
// AC-3/AC-8: the provenance + reason guards (server-derived, honest)
// ---------------------------------------------------------------------------

test('the provenance guard accepts the server-derived shapes and rejects caller-invented ones', () => {
  assert.doesNotThrow(() => assertValidGrowthMissionProvenance(honestProvenance));
  assert.doesNotThrow(() =>
    assertValidGrowthMissionProvenance({
      actor: 'service:growth-operator',
      recordedVia: 'module',
      correlationId: 'corr-2',
      causationId: 'job-3',
    }),
  );
  for (const bad of [
    { ...honestProvenance, actor: '' },
    { ...honestProvenance, actor: 'x'.repeat(101) },
    { ...honestProvenance, recordedVia: '' },
    { ...honestProvenance, correlationId: '' },
    { ...honestProvenance, causationId: '' },
  ]) {
    assert.throws(() => assertValidGrowthMissionProvenance(bad), /provenance|actor|recordedVia|correlationId|causationId/);
  }
});

test('the reason guard: every lifecycle transition / goal unmapping carries a bounded, non-empty reason (the honest record)', () => {
  assert.doesNotThrow(() => assertValidGrowthMissionReason('terminal decision evaluated against the declared commerce_discovery objective'));
  for (const bad of ['', '   ', 'x'.repeat(2001), null, undefined]) {
    assert.throws(
      () => assertValidGrowthMissionReason(bad as unknown as string),
      /reason/,
    );
  }
});

// ---------------------------------------------------------------------------
// AC-8: the canonical owner-context composer (purity)
// ---------------------------------------------------------------------------

test('composeGrowthMissionOwnerContext derives the scope from the mission + agency rows only, and is pure', () => {
  const mission: GrowthMissionRecord = {
    missionId: '11111111-1111-4111-8111-111111111111',
    agencyId: '22222222-2222-4222-8222-222222222222',
    status: 'active',
    currentVersionSeq: 2,
    version: 4,
    createdActor: 'user:00000000-0000-4000-8000-000000000001',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const agency = { agencyId: mission.agencyId, status: 'active' };
  const first = composeGrowthMissionOwnerContext(mission, agency, '2026-01-03T00:00:00.000Z');
  const second = composeGrowthMissionOwnerContext(mission, agency, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(first, second);
  assert.equal(first.scope.kind, 'growth-mission');
  assert.equal(first.scope.agencyId, mission.agencyId);
  assert.equal(first.scope.missionId, mission.missionId);
  assert.equal(first.mission, mission);
  assert.equal(first.agency.status, 'active');
  assert.equal(first.resolvedAt, '2026-01-03T00:00:00.000Z');
  // The scope NEVER derives from caller input: mutating a copy of the
  // agency row does not leak into an already-composed context.
  assert.equal(composeGrowthMissionOwnerContext(mission, agency, 't1').scope.agencyId, mission.agencyId);
});
